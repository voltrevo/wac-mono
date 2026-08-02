// FSE, against tables real zstd wrote and an invariant it cannot fake.
//
// There is no oracle for FSE on its own: nothing exposes "decode this table" the way Node
// exposes zstd as a whole. So the strongest check available is indirect, and it is a good one.
//
// A zstd frame's literals are Huffman-coded, and the Huffman *weights* are themselves
// FSE-coded. Huffman weights are not arbitrary: `sum of 2^(weight-1)` over the transmitted
// weights must fall exactly one power of two short, because the remainder is the last symbol's
// weight and a Huffman code has to be complete. Decode the weights wrongly by a single symbol
// or a single bit and that sum is almost never a power of two short.
//
// So: Node writes a real frame, this file walks it far enough to find the FSE-coded weights —
// no FSE, just header arithmetic — and wac decodes them. The invariant is the judge.

import { wacBind } from "../../../harness/wacBind.ts";
import { weightBytes } from "./frames.ts";

type Table = { log: number; symbol: Int32Array; nbBits: Int32Array; newState: Int32Array; bytesUsed: number };

const mod = await wacBind("packages/zstd/src/fse.wac") as unknown as {
  decompress(src: Uint8Array, maxSymbol: number, maxLog: number, maxOut: number): Int32Array;
  buildFromCounts(counts: Int32Array, maxSymbol: number, log: number): Table;
  readTable(src: Uint8Array, at: number, maxSymbol: number, maxLog: number): Table;
};

/**
 * The completeness check.
 *
 * Every transmitted weight w > 0 claims 2^(w-1) of the code space. What is left over must be a
 * single power of two, which is the weight of the one symbol whose weight is not transmitted.
 */
function huffmanRemainder(weights: number[]): number {
  let total = 0;
  for (const w of weights) {
    if (w > 0) total += 1 << (w - 1);
  }
  if (total === 0) return -1;
  const maxBits = 32 - Math.clz32(total);
  return (1 << maxBits) - total;
}

const SAMPLES: [string, string][] = [
  ["prose", "the quick brown fox jumps over the lazy dog, and then does it again. ".repeat(400)],
  ["json", JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, name: "item" + i, tags: ["a", "b"] })))],
  ["mixed", ("Lorem ipsum dolor sit amet 12345 " + String.fromCharCode(...Array.from({ length: 60 }, (_, i) => 33 + i))).repeat(300)],
];

Deno.test("weights decoded from real frames complete a Huffman code", async () => {
  let checked = 0;
  for (const [name, text] of SAMPLES) {
    const bytes = await weightBytes(text);
    if (bytes === null) continue;

    // maxSymbol 255 and accuracy log at most 6: what the format allows for weights.
    const weights = Array.from(mod.decompress(bytes, 255, 6, 256));
    if (weights.length === 0) throw new Error(`${name}: no weights decoded`);
    if (weights.some(w => w < 0 || w > 12)) {
      throw new Error(`${name}: weight out of range in ${JSON.stringify(weights.slice(0, 20))}`);
    }

    const left = huffmanRemainder(weights);
    if (left <= 0 || (left & (left - 1)) !== 0) {
      throw new Error(
        `${name}: ${weights.length} weights leave ${left}, which is not a power of two — ` +
        `so they are not a Huffman code and the FSE decode is wrong`,
      );
    }
    checked++;
  }
  if (checked === 0) throw new Error("no sample produced FSE-coded weights; the test proved nothing");
});

Deno.test("the same frame decodes the same way every time", async () => {
  // Cheap, and it catches state left behind between calls — which a table built into module
  // scope rather than per call would produce.
  const bytes = await weightBytes(SAMPLES[0][1]);
  if (bytes === null) throw new Error("no FSE weights to decode");
  const first = Array.from(mod.decompress(bytes, 255, 6, 256));
  for (let i = 0; i < 3; i++) {
    const again = Array.from(mod.decompress(bytes, 255, 6, 256));
    if (JSON.stringify(again) !== JSON.stringify(first)) throw new Error(`run ${i} differs`);
  }
});

Deno.test("the predefined distributions build usable tables", () => {
  // RFC 8878's default distributions, used by any block that says Predefined_Mode. Building
  // them exercises the spread and transition code on the exact inputs the format guarantees
  // will appear — including the -1 counts, which are placed from the end backwards rather than
  // spread, and which no hand-made example would think to include.
  const LITERAL_LENGTH = [
    4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1,
  ];
  const MATCH_LENGTH = [
    1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1,
    -1, -1, -1, -1, -1,
  ];
  const OFFSET = [
    1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    -1, -1, -1, -1, -1,
  ];

  for (const [name, counts, log] of [
    ["literal lengths", LITERAL_LENGTH, 6],
    ["match lengths", MATCH_LENGTH, 6],
    ["offsets", OFFSET, 5],
  ] as [string, number[], number][]) {
    const sum = counts.reduce((n, c) => n + (c < 0 ? 1 : c), 0);
    if (sum !== 1 << log) throw new Error(`${name}: counts sum to ${sum}, want ${1 << log}`);

    const t = mod.buildFromCounts(Int32Array.from(counts), counts.length - 1, log);
    const size = 1 << log;
    if (t.symbol.length !== size) throw new Error(`${name}: ${t.symbol.length} states, want ${size}`);

    // Every state must name a real symbol, read a possible number of bits, and land inside the
    // table for every value those bits can take. A spread that visited a slot twice, or a
    // transition off the end, fails here.
    const seen = new Array(counts.length).fill(0);
    for (let u = 0; u < size; u++) {
      const s = t.symbol[u];
      if (s < 0 || s >= counts.length) throw new Error(`${name}: state ${u} names symbol ${s}`);
      seen[s]++;
      const bits = t.nbBits[u];
      if (bits < 0 || bits > log) throw new Error(`${name}: state ${u} reads ${bits} bits`);
      const lo = t.newState[u];
      const hi = lo + (1 << bits) - 1;
      if (lo < 0 || hi >= size) throw new Error(`${name}: state ${u} goes to ${lo}..${hi}, outside 0..${size - 1}`);
    }
    // And each symbol must occupy exactly as many states as its count claimed.
    for (let s = 0; s < counts.length; s++) {
      const want = counts[s] < 0 ? 1 : counts[s];
      if (seen[s] !== want) throw new Error(`${name}: symbol ${s} holds ${seen[s]} states, want ${want}`);
    }
  }
});

Deno.test("nonsense is refused rather than decoded", () => {
  for (const bad of [
    new Uint8Array(0),
    new Uint8Array([0xff]),
    new Uint8Array([0x00]),
    new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    new Uint8Array([0x20, 0x00, 0x00, 0x00, 0x00]),
  ]) {
    let trapped = false;
    try {
      mod.decompress(bad, 255, 6, 256);
    } catch {
      trapped = true;
    }
    if (!trapped) throw new Error(`accepted ${bad.length} bytes of nonsense`);
  }
});

import { writeDescription } from "./writer.ts";

Deno.test("a description written from counts reads back as those counts", () => {
  // The reader against the writer, on distributions chosen to be awkward rather than typical:
  // long runs of unused symbols, counts that sit exactly on the boundary where the field
  // narrows, and distributions made almost entirely of "less than one" symbols.
  //
  // Compared through the built table rather than the counts, because that is what both sides
  // produce and it is stricter — two distributions that differed only in how they were spelled
  // would still have to build the same states.
  const cases: [string, number[], number][] = [
    ["flat", Array(16).fill(4), 6],
    ["one symbol takes most", [60, 1, 1, 1, 1], 6],
    ["a long run of unused", [32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32], 6],
    ["runs of exactly three", [16, 0, 0, 0, 16, 0, 0, 0, 32], 6],
    ["mostly rare", [59, -1, -1, -1, -1, -1], 6],
    ["rare between used", [30, -1, 16, -1, 16], 6],
    // Five is the smallest accuracy log the format can spell, and nine the largest zstd uses.
    ["smallest table", [16, 8, 4, 2, 1, 1], 5],
    ["largest table", [200, 100, 100, 56, 24, 16, 8, 4, 2, 1, 1], 9],
    ["smallest table, all rare but one", [27, -1, -1, -1, -1, -1], 5],
  ];

  for (const [name, counts, log] of cases) {
    const desc = writeDescription(counts, log);
    const read = mod.readTable(desc, 0, counts.length - 1, log);
    const built = mod.buildFromCounts(Int32Array.from(counts), counts.length - 1, log);

    if (read.log !== log) throw new Error(`${name}: read log ${read.log}, want ${log}`);
    for (const field of ["symbol", "nbBits", "newState"] as const) {
      const a = Array.from(read[field]);
      const b = Array.from(built[field]);
      if (a.length !== b.length) throw new Error(`${name}: ${field} has ${a.length} entries, want ${b.length}`);
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          throw new Error(`${name}: ${field}[${i}] is ${a[i]} read back, ${b[i]} built directly`);
        }
      }
    }
    if (read.bytesUsed !== desc.length) {
      throw new Error(`${name}: reader consumed ${read.bytesUsed} bytes of a ${desc.length}-byte description`);
    }
  }
});

Deno.test("fuzz: any distribution the format can express survives the round trip", () => {
  // Random distributions rather than chosen ones. What this reaches that the table above does
  // not is the interaction between the three moving parts: where the field narrows depends on
  // the counts before it, so the bit layout of a description depends on its whole prefix, and
  // an off-by-one in the narrowing only shows on some orderings.
  let seed = 0x5eed1234 | 0;
  const rand = (n: number): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed % n;
  };

  for (let trial = 0; trial < 400; trial++) {
    const log = 5 + rand(5);                     // 5..9, the range zstd uses
    const size = 1 << log;
    const symbols = 2 + rand(30);

    // Deal the table out: some symbols rare, some unused, the rest sharing what is left.
    const counts: number[] = [];
    let left = size;
    for (let s = 0; s < symbols && left > 0; s++) {
      const roll = rand(10);
      if (roll === 0 && left > 1) {
        counts.push(-1);                          // "less than one"
        left -= 1;
      } else if (roll < 3) {
        counts.push(0);                           // unused, and the start of a possible run
      } else {
        const take = 1 + rand(left);
        counts.push(take);
        left -= take;
      }
    }
    if (left > 0) counts.push(left);
    // A description stops when the mass runs out, so trailing zeros are never transmitted and
    // must not be part of what we compare.
    while (counts.length > 0 && counts[counts.length - 1] === 0) counts.pop();
    if (counts.reduce((n, c) => n + Math.abs(c), 0) !== size) continue;

    const desc = writeDescription(counts, log);
    const read = mod.readTable(desc, 0, counts.length - 1, log);
    const built = mod.buildFromCounts(Int32Array.from(counts), counts.length - 1, log);

    for (const field of ["symbol", "nbBits", "newState"] as const) {
      const a = read[field], b = built[field];
      for (let i = 0; i < b.length; i++) {
        if (a[i] !== b[i]) {
          throw new Error(
            `trial ${trial} (log ${log}, counts ${JSON.stringify(counts)}): ` +
            `${field}[${i}] is ${a[i]} read back, ${b[i]} built directly`,
          );
        }
      }
    }
  }
});
