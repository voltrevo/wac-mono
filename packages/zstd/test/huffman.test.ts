// Huffman-coded literals, against real frames and an ordering the format guarantees.
//
// The check that does the work: **literals are a subsequence of the block's content.** They are
// exactly the bytes a match did not cover, in order, so every literal must appear in the source
// in the same sequence. Decode one symbol wrongly, drop one, or read a stream backwards and
// that fails — while a weaker check like "same set of bytes" would not.
//
// Two more constraints come free from the section header: how many literals there are, and how
// many bytes they occupy. Both are the encoder's own numbers, so hitting them exactly is not
// something a wrong decoder does by accident.

import { wacBind } from "../../../harness/wacBind.ts";
import { type LitHeader, literalsSection } from "./frames.ts";

type Table = { maxBits: number; symbol: Int32Array; nbBits: Int32Array; bytesUsed: number };

const mod = await wacBind("packages/zstd/src/huffman.wac") as unknown as {
  readTable(src: Uint8Array, at: number): Table;
  decodeLiterals(
    t: Table, src: Uint8Array, at: number, len: number, count: number, streams: number,
  ): Uint8Array;
};

const enc = new TextEncoder();

/** Is `a` a subsequence of `b`? */
function isSubsequence(a: Uint8Array, b: Uint8Array): boolean {
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j++) {
    if (a[i] === b[j]) i++;
  }
  return i === a.length;
}

const SAMPLES: [string, string][] = [
  ["prose", "the quick brown fox jumps over the lazy dog, and then does it again. ".repeat(400)],
  ["json", JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, name: "item" + i, tags: ["a", "b"] })))],
  ["mixed", ("Lorem ipsum dolor sit amet 12345 " + String.fromCharCode(...Array.from({ length: 60 }, (_, i) => 33 + i))).repeat(300)],
  ["short", "hello hello hello hello hello world"],
  ["skewed", "a".repeat(3000) + "bcdefghij".repeat(50)],
];

/** Decode the literals of a sample's first compressed block, if they are Huffman-coded. */
async function literalsOf(text: string): Promise<{ head: LitHeader; literals: Uint8Array } | null> {
  const found = await literalsSection(text);
  if (found === null || found.head.type !== 2) return null;    // 2 is Huffman-coded
  const { frame, at, head } = found;
  const t = mod.readTable(frame, at + head.hdr);
  const streamsAt = at + head.hdr + t.bytesUsed;
  const streamsLen = head.comp - t.bytesUsed;
  const literals = mod.decodeLiterals(t, frame, streamsAt, streamsLen, head.regen, head.streams);
  return { head, literals };
}

Deno.test("decoded literals are a subsequence of what was compressed", async () => {
  let checked = 0;
  const streamCounts = new Set<number>();
  for (const [name, text] of SAMPLES) {
    const got = await literalsOf(text);
    if (got === null) continue;

    if (got.literals.length !== got.head.regen) {
      throw new Error(`${name}: ${got.literals.length} literals, header says ${got.head.regen}`);
    }
    if (!isSubsequence(got.literals, enc.encode(text))) {
      throw new Error(`${name}: the literals are not a subsequence of the input`);
    }
    streamCounts.add(got.head.streams);
    checked++;
  }
  if (checked === 0) throw new Error("no sample had Huffman-coded literals; the test proved nothing");
  // Four streams and one stream are different code paths — the jump table, and the split of the
  // literal count into quarters. Worth knowing which the corpus actually reached.
  if (streamCounts.size === 0) throw new Error("no stream layouts seen");
});

Deno.test("both stream layouts are exercised", async () => {
  // A small literals section uses one stream because the six-byte jump table is not worth it;
  // a large one uses four. If the corpus only ever produced one of them, half the decoder would
  // be untested and the test above would still pass.
  const seen = new Set<number>();
  for (const [, text] of SAMPLES) {
    const found = await literalsSection(text);
    if (found !== null && found.head.type === 2) seen.add(found.head.streams);
  }
  for (const want of [1, 4]) {
    if (!seen.has(want)) throw new Error(`no sample produced a ${want}-stream literals section: saw ${[...seen]}`);
  }
});

Deno.test("a table built from directly-written weights is a complete prefix code", () => {
  // The other tree description form: weights as nibbles rather than FSE-coded. Small alphabets
  // use it, and it is easy to write by hand, which makes it the place to check the table build
  // itself rather than the decoding around it.
  //
  // The last weight is never transmitted — it is whatever completes the code — so each case
  // below writes one fewer weight than it has symbols.
  const cases: [string, number[]][] = [
    ["two symbols", [1]],
    ["four equal", [1, 1, 1]],
    ["one common, three rare", [2, 1, 1]],
    ["a deep code", [1, 1, 2, 3, 4]],
    ["unused symbols in the middle", [3, 0, 0, 2, 1]],
    ["eight equal", [1, 1, 1, 1, 1, 1, 1]],
  ];

  for (const [name, weights] of cases) {
    const bytes = [128 + weights.length];                    // direct form
    for (let i = 0; i < weights.length; i += 2) {
      bytes.push((weights[i] << 4) | (weights[i + 1] ?? 0));
    }
    const t = mod.readTable(new Uint8Array(bytes), 0);

    const size = 1 << t.maxBits;
    if (t.symbol.length !== size) throw new Error(`${name}: ${t.symbol.length} entries, want ${size}`);

    // Every entry must be assigned, and every symbol must hold exactly the number of entries
    // its weight claims — which is what makes the code complete rather than merely valid.
    const held = new Map<number, number>();
    for (let i = 0; i < size; i++) {
      const bits = t.nbBits[i];
      if (bits < 1 || bits > t.maxBits) throw new Error(`${name}: entry ${i} reads ${bits} bits`);
      held.set(t.symbol[i], (held.get(t.symbol[i]) ?? 0) + 1);
    }
    const total = [...held.values()].reduce((a, b) => a + b, 0);
    if (total !== size) throw new Error(`${name}: entries cover ${total} of ${size}`);

    for (const [sym, n] of held) {
      const w = sym < weights.length ? weights[sym] : lastWeight(weights, t.maxBits);
      if (n !== (1 << (w - 1))) throw new Error(`${name}: symbol ${sym} holds ${n} entries, weight ${w} claims ${1 << (w - 1)}`);
    }
  }
});

/** The weight the encoder did not send: whatever completes the code space. */
function lastWeight(weights: number[], maxBits: number): number {
  let total = 0;
  for (const w of weights) {
    if (w > 0) total += 1 << (w - 1);
  }
  return 32 - Math.clz32((1 << maxBits) - total);
}

Deno.test("nonsense trees are refused", () => {
  for (const bad of [
    new Uint8Array(0),
    new Uint8Array([128]),                       // claims one weight, has no bytes
    new Uint8Array([129]),                       // claims two weights, has no bytes
    new Uint8Array([130, 0x00]),                 // all weights zero: no code at all
    new Uint8Array([131, 0xff, 0xff]),           // weights past the maximum code length
    new Uint8Array([130, 0x11]),                 // leaves code space that is not a power of two
    new Uint8Array([0]),                         // an FSE description of zero length
    new Uint8Array([4, 0, 0, 0, 0]),             // an FSE description of nonsense
  ]) {
    let trapped = false;
    try {
      mod.readTable(bad, 0);
    } catch {
      trapped = true;
    }
    if (!trapped) throw new Error(`accepted ${Array.from(bad).join(",")}`);
  }
});
