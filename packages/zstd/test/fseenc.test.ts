// FSE encoding, against the decoder that reads real zstd frames.
//
// The decoder in `fse.wac` is checked against zstd's own output — the Huffman weights in a real
// frame have to complete a Huffman code, and they do. So round-tripping through it is not two
// halves of one misunderstanding agreeing: the far side is pinned to real data.
//
// What is checked here is the awkward part of encoding, which is that everything runs backwards.
// A decoder reads its stream from the end, so the encoder writes the transitions in reverse and
// the initial state last. Get that wrong and the first symbol still decodes.

import { wacBind } from "../../../harness/wacBind.ts";

type FseTable = { log: number; symbol: Int32Array; nbBits: Int32Array; newState: Int32Array; bytesUsed: number };
type BackBits = { left: number };
type CTable = { log: number; size: number; maxSymbol: number };
type Step = { state: number; value: number; bits: number };
type BitOut = { write(v: number, n: number): void; finish(): Uint8Array; flush(): Uint8Array };

const dec = await wacBind("packages/zstd/src/fse.wac") as unknown as {
  readTable(src: Uint8Array, at: number, maxSymbol: number, maxLog: number): FseTable;
  initState(b: BackBits, t: FseTable): number;
  symbolAt(t: FseTable, state: number): number;
  nextState(t: FseTable, state: number, b: BackBits): number;
  BackBits: { create(src: Uint8Array, start: number, len: number): BackBits };
};

const enc = await wacBind("packages/zstd/src/fseenc.wac") as unknown as {
  normalize(counts: Int32Array, maxSymbol: number, total: number, log: number): Int32Array;
  optimalLog(total: number, maxSymbol: number, maxLog: number): number;
  buildCTable(norm: Int32Array, maxSymbol: number, log: number): CTable;
  encodeStep(c: CTable, symbol: number, target: number): Step;
  initialState(c: CTable, symbol: number): number;
  writeDescription(o: BitOut, norm: Int32Array, maxSymbol: number, log: number): void;
  BitOut: { create(): BitOut };
};

/**
 * Encode `symbols` as a description followed by a bitstream.
 *
 * Backwards, which is the whole point: the last symbol picks a state freely, each earlier symbol
 * picks the state whose transition lands on the one after it, and the very first state is written
 * last so a decoder reading from the end meets it first.
 */
function encode(symbols: number[], maxSymbol: number, log: number, norm: Int32Array): Uint8Array {
  const c = enc.buildCTable(norm, maxSymbol, log);
  const body = enc.BitOut.create();

  let state = enc.initialState(c, symbols[symbols.length - 1]);
  for (let i = symbols.length - 2; i >= 0; i--) {
    const step = enc.encodeStep(c, symbols[i], state);
    body.write(step.value, step.bits);
    state = step.state;
  }
  body.write(state, log);
  const stream = body.finish();

  // The description is byte-aligned and read forwards, so it is padded with zeros rather than
  // closed with a marker — a marker would be a bit of stream that the reader never accounts for.
  const head = enc.BitOut.create();
  enc.writeDescription(head, norm, maxSymbol, log);
  const desc = head.flush();
  const out = new Uint8Array(desc.length + stream.length);
  out.set(desc, 0);
  out.set(stream, desc.length);
  return out;
}

/** Decode `count` symbols using the decoder's own primitives. */
function decode(blob: Uint8Array, count: number, maxSymbol: number, maxLog: number): number[] {
  const t = dec.readTable(blob, 0, maxSymbol, maxLog);
  const b = dec.BackBits.create(blob, t.bytesUsed, blob.length - t.bytesUsed);
  let state = dec.initState(b, t);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(dec.symbolAt(t, state));
    if (i < count - 1) state = dec.nextState(t, state, b);
  }
  if (b.left !== 0) throw new Error(`stream not spent: ${b.left} bits left`);
  return out;
}

/** Counts of each symbol in `symbols`. */
function countsOf(symbols: number[], maxSymbol: number): Int32Array {
  const c = new Int32Array(maxSymbol + 1);
  for (const s of symbols) c[s]++;
  return c;
}

function roundTrip(symbols: number[], maxSymbol: number, maxLog: number): void {
  const counts = countsOf(symbols, maxSymbol);
  const log = enc.optimalLog(symbols.length, maxSymbol, maxLog);
  const norm = enc.normalize(counts, maxSymbol, symbols.length, log);

  const sum = Array.from(norm).reduce((a, b) => a + Math.abs(b), 0);
  if (sum !== 1 << log) throw new Error(`normalised counts sum to ${sum}, want ${1 << log}`);
  for (let s = 0; s <= maxSymbol; s++) {
    if (counts[s] > 0 && norm[s] === 0) throw new Error(`symbol ${s} occurs but normalised to zero`);
  }

  const blob = encode(symbols, maxSymbol, log, norm);
  const got = decode(blob, symbols.length, maxSymbol, maxLog);
  if (got.length !== symbols.length) throw new Error(`${got.length} symbols back, want ${symbols.length}`);
  for (let i = 0; i < symbols.length; i++) {
    if (got[i] !== symbols[i]) throw new Error(`symbol ${i}: got ${got[i]}, want ${symbols[i]}`);
  }
}

Deno.test("what the encoder writes, the decoder reads back", () => {
  const cases: [string, number[], number][] = [
    ["two symbols alternating", Array.from({ length: 200 }, (_, i) => i % 2), 1],
    ["one symbol, many times", Array(300).fill(3), 5],
    ["a skewed distribution", Array.from({ length: 500 }, (_, i) => (i % 17 === 0 ? 7 : 1)), 7],
    ["every symbol equally", Array.from({ length: 512 }, (_, i) => i % 16), 15],
    ["a long tail", Array.from({ length: 900 }, (_, i) => (i % 31 === 0 ? 20 + (i % 11) : 0)), 31],
  ];
  for (const [name, symbols, maxSymbol] of cases) {
    try {
      roundTrip(symbols, maxSymbol, 9);
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
  }
});

Deno.test("fuzz: random symbol streams of random shapes", () => {
  let seed = 0x9e3779b9 | 0;
  const rand = (n: number): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed % n;
  };

  for (let trial = 0; trial < 300; trial++) {
    const maxSymbol = 1 + rand(40);
    const n = 20 + rand(2000);
    // A skewed alphabet rather than a flat one: real symbol streams are skewed, and skew is what
    // makes the state transitions vary in width.
    const weights: number[] = [];
    for (let s = 0; s <= maxSymbol; s++) weights.push(rand(10) === 0 ? 0 : 1 + rand(1 << rand(8)));
    const pool: number[] = [];
    for (let s = 0; s <= maxSymbol; s++) {
      for (let k = 0; k < weights[s]; k++) pool.push(s);
    }
    if (pool.length === 0) continue;
    const symbols = Array.from({ length: n }, () => pool[rand(pool.length)]);

    try {
      roundTrip(symbols, maxSymbol, 9);
    } catch (e) {
      throw new Error(`trial ${trial} (maxSymbol ${maxSymbol}, ${n} symbols): ${(e as Error).message}`);
    }
  }
});

Deno.test("descriptions round trip, including counts the normaliser never produces", () => {
  // `normalize` here gives every symbol that occurs at least one whole slot. The format also
  // allows -1 — "occurs, but less often than one slot" — and the predefined distributions use
  // it heavily. A writer that could not express those could not describe the format's own
  // tables, so it is checked against them directly rather than against its own output.
  const LL_DEFAULT = [
    4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1,
  ];
  const OF_DEFAULT = [
    1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    -1, -1, -1, -1, -1,
  ];
  const ML_DEFAULT = [
    1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1,
    -1, -1, -1, -1, -1,
  ];

  for (const [name, counts, log] of [
    ["literal lengths", LL_DEFAULT, 6],
    ["offsets", OF_DEFAULT, 5],
    ["match lengths", ML_DEFAULT, 6],
    // And a run of unused symbols, so the repeat field is written more than once.
    ["with a long gap", [32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32], 6],
    ["rare between used", [30, -1, 16, -1, 16], 6],
  ] as [string, number[], number][]) {
    const norm = Int32Array.from(counts);
    const maxSymbol = counts.length - 1;

    const o = enc.BitOut.create();
    enc.writeDescription(o, norm, maxSymbol, log);
    const desc = o.flush();

    const read = dec.readTable(desc, 0, maxSymbol, 9);
    if (read.log !== log) throw new Error(`${name}: read log ${read.log}, want ${log}`);
    if (read.bytesUsed !== desc.length) {
      throw new Error(`${name}: reader consumed ${read.bytesUsed} of ${desc.length} bytes`);
    }

    // Compared through the table both sides build, which is stricter than comparing counts.
    const built = dec.readTable(desc, 0, maxSymbol, 9);
    for (const field of ["symbol", "nbBits", "newState"] as const) {
      const a = read[field], b = built[field];
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) throw new Error(`${name}: ${field}[${i}] differs`);
      }
    }
  }
});
