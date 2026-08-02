// Branch coverage for zstd's frame layer.
//
// The interesting axis is the frame header, because its descriptor byte changes the size of
// everything after it: three content-size widths, four dictionary-id widths, single-segment or
// not, checksum or not. Those combinations are hand-built rather than produced, because one
// encoder only ever emits the handful it prefers — and a decoder is judged on what it accepts,
// not on what one encoder happens to write.
//
//   deno task coverage:zstd

import { instrument, report } from "../../harness/wacCoverage.ts";
import { weightBytes } from "./test/frames.ts";
import { writeDescription } from "./test/writer.ts";
import { literalsSection } from "./test/frames.ts";

const verbose = Deno.args.includes("--verbose");

const run = await instrument("packages/zstd/src/frame.wac");
const m = run.mod as unknown as { decompress(src: Uint8Array): Uint8Array };

function ignoringTraps(f: () => void): void {
  try {
    f();
  } catch {
    // A trap is one of the outcomes under test here, not a failure.
  }
}

/** A frame carrying one block, with the header fields spelled out rather than inferred. */
function frame(opts: {
  singleSegment?: boolean;
  fcsFlag?: number;
  contentSize?: number;
  checksum?: boolean;
  didFlag?: number;
  dictId?: number;
  windowDescriptor?: number;
  block: number[];
}): Uint8Array {
  const single = opts.singleSegment ?? true;
  const fcsFlag = opts.fcsFlag ?? 0;
  const didFlag = opts.didFlag ?? 0;
  const out: number[] = [0x28, 0xb5, 0x2f, 0xfd];
  out.push((fcsFlag << 6) | ((single ? 1 : 0) << 5) | ((opts.checksum ? 1 : 0) << 2) | didFlag);
  if (!single) out.push(opts.windowDescriptor ?? 0);
  for (let i = 0; i < [0, 1, 2, 4][didFlag]; i++) out.push((opts.dictId ?? 0) >>> (8 * i) & 0xff);
  const width = fcsFlag === 0 ? (single ? 1 : 0) : [1, 2, 4, 8][fcsFlag];
  const cs = opts.contentSize ?? 0;
  for (let i = 0; i < width; i++) out.push(Math.floor(cs / 2 ** (8 * i)) & 0xff);
  out.push(...opts.block);
  if (opts.checksum) out.push(0, 0, 0, 0);
  return new Uint8Array(out);
}

function blockHeader(type: number, size: number, last: boolean): number[] {
  const h = (size << 3) | (type << 1) | (last ? 1 : 0);
  return [h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff];
}

const raw = (bytes: number[], last = true) => [...blockHeader(0, bytes.length, last), ...bytes];
const rle = (value: number, count: number, last = true) => [...blockHeader(1, count, last), value];

// Every content-size width, including the two-byte form's 256 offset and the eight-byte one.
ignoringTraps(() => m.decompress(frame({ contentSize: 3, block: raw([1, 2, 3]) })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 1, contentSize: 3 - 256, block: raw([1, 2, 3]) })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 3, block: raw([1, 2, 3]) })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 3, contentSize: 3, block: raw([1, 2, 3]) })));

// Not single-segment, so a window descriptor is read: the smallest, a mantissa, and one past
// what an i32 window can address.
for (const wd of [0, 0x07, 0x40, 0xA0, 0xF8]) {
  ignoringTraps(() => m.decompress(frame({
    singleSegment: false, fcsFlag: 2, contentSize: 3, windowDescriptor: wd, block: raw([1, 2, 3]),
  })));
}

// Every dictionary-id width.
for (const didFlag of [0, 1, 2, 3]) {
  ignoringTraps(() => m.decompress(frame({
    fcsFlag: 2, contentSize: 3, didFlag, dictId: 0x11223344, block: raw([1, 2, 3]),
  })));
}

// A checksum field, which is stepped over until XXH64 exists.
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 3, checksum: true, block: raw([1, 2, 3]) })));

// Both plain block types, several blocks in a frame, and an empty one.
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 0, block: raw([]) })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 6, block: [...raw([1, 2, 3], false), ...raw([4, 5, 6])] })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 300, block: rle(0x61, 300) })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 300, block: [...rle(0x61, 100, false), ...raw([9, 9])] })));

// Every rejection: reserved bit, reserved block type, compressed block, oversized block, a
// block claiming more than the input holds, a wrong content size, and a truncated header.
ignoringTraps(() => m.decompress(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x28, 3, ...raw([1, 2, 3])])));
ignoringTraps(() => m.decompress(frame({ contentSize: 3, block: [...blockHeader(3, 3, true), 1, 2, 3] })));
ignoringTraps(() => m.decompress(frame({ contentSize: 3, block: [...blockHeader(2, 3, true), 1, 2, 3] })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 3, block: blockHeader(0, 200000, true) })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 3, block: blockHeader(1, 200000, true) })));
ignoringTraps(() => m.decompress(frame({ contentSize: 3, block: [...blockHeader(0, 99, true), 1, 2, 3] })));
ignoringTraps(() => m.decompress(frame({ contentSize: 9, block: raw([1, 2, 3]) })));
ignoringTraps(() => m.decompress(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd])));
ignoringTraps(() => m.decompress(new Uint8Array([0x28, 0xb5])));
ignoringTraps(() => m.decompress(new Uint8Array([0x28, 0xb5, 0x2f, 0xfe, 0, 0, 0, 0])));
ignoringTraps(() => m.decompress(new Uint8Array(0)));

// An eight-byte content size with the top bit set, which reads back as a negative i64. A
// single-segment frame takes its window from that field, so it has to be refused rather than
// used as a length.
ignoringTraps(() => m.decompress(new Uint8Array([
  0x28, 0xb5, 0x2f, 0xfd, (3 << 6) | (1 << 5),
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ...raw([1, 2, 3]),
])));

// Skippable frames: the first magic, the last, one with content, and one claiming too much.
for (const [magic, size, extra] of [
  [0x184D2A50, 4, [1, 2, 3, 4]],
  [0x184D2A5F, 0, []],
  [0x184D2A55, 99, []],
  // A size with the top bit set, which is negative read as an i32 and must not become a
  // backwards seek.
  [0x184D2A51, 0x80000000, []],
] as [number, number, number[]][]) {
  const head = [magic & 0xff, (magic >>> 8) & 0xff, (magic >>> 16) & 0xff, (magic >>> 24) & 0xff,
                size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, (size >>> 24) & 0xff];
  ignoringTraps(() => m.decompress(new Uint8Array([...head, ...extra])));
}

// ── FSE ───────────────────────────────────────────────────────────────────────
//
// Real weight descriptions from zstd's own encoder, plus hand-built ones for the shapes real
// data does not reach: long runs of unused symbols, a description that claims more probability
// than the table has, and an accuracy log past what the caller allows.

const fse = await instrument("packages/zstd/src/fse.wac");
const f = fse.mod as unknown as {
  decompress(src: Uint8Array, maxSymbol: number, maxLog: number, maxOut: number): Int32Array;
  buildFromCounts(counts: Int32Array, maxSymbol: number, log: number): unknown;
  readTable(src: Uint8Array, at: number, maxSymbol: number, maxLog: number): unknown;
};

for (
  const text of [
    "the quick brown fox jumps over the lazy dog, and then does it again. ".repeat(400),
    JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, name: "item" + i }))),
    // Few distinct bytes, so most symbols are unused and the zero-run path does the work.
    "abababab".repeat(6000) + "c".repeat(200),
  ]
) {
  const bytes = await weightBytes(text);
  if (bytes !== null) ignoringTraps(() => f.decompress(bytes, 255, 6, 256));
}

// Descriptions written from chosen counts, which is the only way to reach the shapes real
// output does not: runs of unused symbols long enough to need the repeat field more than once,
// tables built almost entirely of "less than one" symbols, and both ends of the accuracy log.
for (
  const [counts, log] of [
    [[16, 8, 4, 2, 1, 1], 5],
    [[27, -1, -1, -1, -1, -1], 5],
    [[32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32], 6],
    [[16, 0, 0, 0, 16, 0, 0, 0, 32], 6],
    [[60, 1, 1, 1, 1], 6],
    [[30, -1, 16, -1, 16], 6],
    [[200, 100, 100, 56, 24, 16, 8, 4, 2, 1, 1], 9],
  ] as [number[], number][]
) {
  const desc = writeDescription(counts, log);
  ignoringTraps(() => f.readTable(desc, 0, counts.length - 1, log));
  // And the same description with a stream behind it, so the decode loop runs over a table
  // whose shape came from here rather than from zstd.
  ignoringTraps(() => f.decompress(
    new Uint8Array([...desc, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0x01]),
    counts.length - 1, log, 64,
  ));
}

// The predefined distributions, which are the only place -1 counts are guaranteed to appear.
for (
  const [counts, log] of [
    [[4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1], 6],
    [[1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1], 5],
  ] as [number[], number][]
) {
  ignoringTraps(() => f.buildFromCounts(Int32Array.from(counts), counts.length - 1, log));
}

// Refusals that need a *valid* description and an invalid use of it: more symbols than the
// caller allows, an output bound too small to hold what the stream decodes to, and a stream
// whose last byte carries no marker bit.
{
  const desc = writeDescription([16, 8, 4, 2, 1, 1], 5);
  const stream = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a]);
  const blob = new Uint8Array([...desc, ...stream]);
  ignoringTraps(() => f.readTable(desc, 0, 2, 5));            // six symbols, three allowed
  ignoringTraps(() => f.decompress(blob, 2, 5, 64));
  // Every cap from one to a dozen: the decode loop checks the bound in four places, and which
  // one fires depends on whether it stopped on the first state or the second.
  for (let cap = 1; cap <= 12; cap++) ignoringTraps(() => f.decompress(blob, 5, 5, cap));
  const longer = new Uint8Array([...desc, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x81]);
  for (let cap = 1; cap <= 12; cap++) ignoringTraps(() => f.decompress(longer, 5, 5, cap));
  ignoringTraps(() => f.decompress(new Uint8Array([...desc, 0x00]), 5, 5, 64));

  // A run of unused symbols that overruns the caller's limit, which is the other place the
  // symbol bound is checked.
  const runs = writeDescription([32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32], 6);
  for (const limit of [0, 1, 2, 4, 8, 15]) ignoringTraps(() => f.readTable(runs, 0, limit, 6));
  // And a description with no run at all, so the bound is reached on an ordinary count.
  const dense = writeDescription([8, 8, 8, 8, 8, 8, 8, 8], 6);
  for (const limit of [0, 1, 2, 3, 5] ) ignoringTraps(() => f.readTable(dense, 0, limit, 6));
}

// Counts that do not tile the table, so the spread cannot return to where it started.
for (
  const [counts, log] of [
    [[16, 8, 4], 5],                                          // too few
    [[40, 40], 5],                                            // too many
    [[1], 5],
  ] as [number[], number][]
) {
  ignoringTraps(() => f.buildFromCounts(Int32Array.from(counts), counts.length - 1, log));
}

// Rejections: empty, no marker byte, an accuracy log past the limit, a description with no
// stream behind it, and counts that do not add up.
for (
  const [bad, maxLog] of [
    [new Uint8Array(0), 6],
    [new Uint8Array([0x00]), 6],
    [new Uint8Array([0xff]), 6],
    [new Uint8Array([0x0f, 0xff, 0xff, 0xff]), 6],
    [new Uint8Array([0x20, 0x00, 0x00, 0x00, 0x00]), 6],
    [new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 9],
    [new Uint8Array([0x01, 0x00, 0x01]), 6],
    [new Uint8Array([0x10, 0x40, 0x01]), 9],
  ] as [Uint8Array, number][]
) {
  ignoringTraps(() => f.decompress(bad, 255, maxLog, 256));
  ignoringTraps(() => f.decompress(bad, 8, maxLog, 8));
}

// ── Huffman literals ──────────────────────────────────────────────────────────
//
// Real sections for the FSE-coded tree description and both stream layouts; hand-written
// direct weights for the shapes a real encoder does not choose, since it only writes the direct
// form for small alphabets.

const huff = await instrument("packages/zstd/src/huffman.wac");
const h = huff.mod as unknown as {
  readTable(src: Uint8Array, at: number): { maxBits: number; bytesUsed: number };
  decodeLiterals(t: unknown, src: Uint8Array, at: number, len: number, count: number, streams: number): Uint8Array;
};

for (
  const text of [
    "the quick brown fox jumps over the lazy dog, and then does it again. ".repeat(400),
    JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, name: "item" + i, tags: ["a", "b"] }))),
    "hello hello hello hello hello world",
    "a".repeat(3000) + "bcdefghij".repeat(50),
  ]
) {
  const found = await literalsSection(text);
  if (found === null || found.head.type !== 2) continue;
  const { frame, at, head } = found;
  ignoringTraps(() => {
    const t = h.readTable(frame, at + head.hdr);
    h.decodeLiterals(t, frame, at + head.hdr + t.bytesUsed, head.comp - t.bytesUsed, head.regen, head.streams);
  });
}

// Direct weights, including an odd count so the trailing nibble is ignored, and both a shallow
// and a deep code.
for (
  const weights of [
    [1], [1, 1, 1], [2, 1, 1], [1, 1, 2, 3, 4], [3, 0, 0, 2, 1], [1, 1, 1, 1, 1, 1, 1],
    [4, 3, 2, 1, 1, 0, 0, 0, 0],
  ]
) {
  const bytes = [128 + weights.length];
  for (let i = 0; i < weights.length; i += 2) bytes.push((weights[i] << 4) | (weights[i + 1] ?? 0));
  const desc = new Uint8Array(bytes);
  ignoringTraps(() => {
    const t = h.readTable(desc, 0);
    // A stream of the wrong length, and an unknown stream count, are both refusals.
    h.decodeLiterals(t, new Uint8Array([...desc, 0x81, 0x42, 0x99]), desc.length, 3, 4, 1);
  });
  ignoringTraps(() => h.decodeLiterals(h.readTable(desc, 0), desc, 0, desc.length, 4, 2));
  ignoringTraps(() => h.decodeLiterals(h.readTable(desc, 0), desc, 0, desc.length, 40, 4));
}

// Trees that are not trees. Each of these reaches a different refusal, and the byte counts
// matter: a description one byte short trips the bounds check before anything is inspected.
for (
  const bad of [
    new Uint8Array(0),
    new Uint8Array([128]),                       // claims a weight, carries none
    new Uint8Array([129, 0x00]),                 // every weight zero, so no code at all
    new Uint8Array([129, 0x13]),                 // leaves code space that is not a power of two
    new Uint8Array([131, 0xbb, 0xbb]),           // weights that need a code longer than allowed
    new Uint8Array([131, 0xff, 0xff]),           // weights past the maximum outright
    new Uint8Array([0]),                         // an FSE description of zero length
    new Uint8Array([10, 0, 0]),                  // an FSE description longer than the input
    new Uint8Array([4, 0, 0, 0, 0]),             // an FSE description of nonsense
  ]
) {
  ignoringTraps(() => h.readTable(bad, 0));
}

// Stream shapes that do not add up: a literal count the stream cannot hold, a count too small
// to split four ways, and a jump table claiming more than the section carries.
{
  const desc = new Uint8Array([129, 0x11]);      // two symbols, one bit each
  const t = h.readTable(desc, 0);
  const stream = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x81]);
  // 63 bits of stream at one bit a symbol: 63 is exact, 64 overruns on the last symbol, and
  // 500 overruns long before the end — three different refusals.
  // Swept rather than chosen: the stream's codes are one and two bits, so which count leaves
  // the *last* symbol straddling the end depends on the bit pattern. That is a different
  // refusal from overrunning in the middle, and only some counts reach it.
  for (let count = 1; count <= 80; count++) {
    ignoringTraps(() => h.decodeLiterals(t, stream, 0, stream.length, count, 1));
  }
  for (const count of [1, 2, 3, 4, 8, 63, 64, 500]) {
    ignoringTraps(() => h.decodeLiterals(t, stream, 0, stream.length, count, 1));
    ignoringTraps(() => h.decodeLiterals(t, stream, 0, stream.length, count, 4));
  }
  ignoringTraps(() => h.decodeLiterals(t, new Uint8Array([0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x81]), 0, 7, 4, 4));
  ignoringTraps(() => h.decodeLiterals(t, stream, 0, 3, 4, 4));

  // A jump table that does add up, with a literal count too small to split four ways: three
  // quarters rounded up already exceed it, so the fourth stream would hold a negative number.
  const four = new Uint8Array([1, 0, 1, 0, 1, 0, 0x81, 0x81, 0x81, 0x81]);
  for (const count of [1, 2, 3]) ignoringTraps(() => h.decodeLiterals(t, four, 0, four.length, count, 4));
}

/**
 * Branches that no input can reach, with the argument for each.
 *
 * Excluded rather than counted as covered: a guard that cannot fire is still worth keeping when
 * what it guards is worse than a wrong answer, but pretending a test reached it would make the
 * number meaningless. Both entries below are checked against the source, so moving the code
 * without moving the entry fails loudly instead of silently excluding the wrong line.
 */
const UNREACHABLE: { file: string; line: number; snippet: string; why: string }[] = [
  {
    file: "packages/zstd/src/fse.wac",
    line: 146,
    snippet: "if (remaining < 0) { trap; }",
    why: "The wire form bounds each count by what is left: the field is masked to " +
      "2*threshold-1 and the long branch subtracts max, which together put the count in " +
      "[0, remaining]. Kept because a negative remaining would drive nbBits below zero in the " +
      "narrowing loop, and a zero-width read never advances — a hang rather than a wrong answer.",
  },
  {
    file: "packages/zstd/src/fse.wac",
    line: 251,
    snippet: "if (len <= 0) { trap; }",
    why: "decompress refuses a description with nothing behind it before constructing a " +
      "BackBits, so the only caller in this package cannot pass a non-positive length. The " +
      "struct is exported for the sequences decoder, which is not written yet and will not " +
      "have that guard for free.",
  },
];

report([run, fse, huff], "packages/zstd/", { verbose });

const source = await Deno.readTextFile("packages/zstd/src/fse.wac");
const lines = source.split("\n");
let stale = false;
for (const u of UNREACHABLE) {
  const at = lines[u.line - 1] ?? "";
  if (!at.includes(u.snippet)) {
    console.log(`\n${u.file}:${u.line} no longer holds ${JSON.stringify(u.snippet)} — it holds:\n  ${at.trim()}`);
    stale = true;
  } else {
    console.log(`\nexcluded as unreachable: ${u.file}:${u.line}  ${u.snippet}\n  ${u.why}`);
  }
}
if (stale) Deno.exit(1);
