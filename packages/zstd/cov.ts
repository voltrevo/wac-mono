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
import { literalsSection, zstd } from "./test/frames.ts";

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

// ── Whole frames ──────────────────────────────────────────────────────────────
//
// Now that a compressed block decodes, the shortest route through most of this package is a
// real frame. The corpus is chosen for the codings it makes the encoder reach — every literals
// kind, every sequence-code mode, blocks of different types meeting in one frame — rather than
// for realism.

const wide = [
  "",
  "x",
  "hello hello hello hello world",
  "ab".repeat(20000),
  "the quick brown fox jumps over the lazy dog, and again. ".repeat(6000),
  JSON.stringify(Array.from({ length: 60000 }, (_, i) => ({ id: i, name: "item" + i }))),
  Array.from({ length: 40000 }, (_, i) => `2026-08-02T10:00:00Z INFO id=${i} path=/api status=200 ms=${i % 97}\n`).join(""),
  "\u0000".repeat(50000),
  // High entropy with occasional long repeats: matches, so the block is compressed, but
  // literals that Huffman cannot help — which is a *raw* literals section inside a compressed
  // block, and past 4096 bytes it uses the widest header form.
  (() => {
    let s = 0x1234 | 0;
    const parts: string[] = [];
    for (let i = 0; i < 40; i++) {
      let noise = "";
      for (let j = 0; j < 6000; j++) {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        noise += String.fromCharCode(s & 0xff);
      }
      parts.push(noise, "a repeated marker phrase that definitely matches. ".repeat(20));
    }
    return parts.join("");
  })(),
];
for (const text of wide) {
  for (const level of [1, 9, 19]) {
    const frame = await zstd(text, level);
    ignoringTraps(() => m.decompress(frame));
  }
  // The same content with a checksum, so the trailer is read and verified rather than skipped.
  const summed = await zstd(text, 3, true);
  ignoringTraps(() => m.decompress(summed));
  // And with its checksum broken, which is the only path that reaches the mismatch.
  if (summed.length > 4) {
    const bad = summed.slice();
    bad[bad.length - 1] ^= 0x40;
    ignoringTraps(() => m.decompress(bad));
  }
}

// Truncations and corruptions of real frames.
//
// Every refusal in the block, sequence and Huffman code is only reachable from data that was
// nearly right — a random byte string trips the magic and gets no further. So: take frames that
// exercise different codings, and damage them one byte at a time, exhaustively. A sampled sweep
// reached about half of these; the checks are close enough together that stepping over bytes
// steps over whole branches.
{
  const frames = [
    await zstd("the quick brown fox jumps over the lazy dog. ".repeat(2000), 9),
    await zstd(JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, n: "x".repeat(i % 13) }))), 19),
    await zstd("ab".repeat(3000), 1),
    await zstd("\u0000".repeat(9000), 3),
    await zstd("hello hello hello world", 1),
    await zstd("mixed content, some of it repeated. ".repeat(50) + "\u00ff\u00fe\u00fd", 3, true),
  ];
  // A frame with treeless literals and Repeat-mode tables, sampled sparsely. Those blocks only
  // appear in large files, and a large file is expensive to decode thousands of times — the step
  // is chosen so this stays a second or two rather than a minute.
  {
    const big = await zstd(JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ id: i, name: "item" + i }))), 9);
    for (let i = 0; i < big.length; i += 997) {
      const bad = big.slice();
      bad[i] ^= 0xff;
      ignoringTraps(() => m.decompress(bad));
    }
  }
  for (const frame of frames) {
    for (let i = 0; i <= frame.length; i++) ignoringTraps(() => m.decompress(frame.slice(0, i)));
    for (let i = 0; i < frame.length; i++) {
      for (const mask of [0x01, 0x40, 0xff]) {
        const bad = frame.slice();
        bad[i] ^= mask;
        ignoringTraps(() => m.decompress(bad));
      }
    }
  }
}

// Compressed blocks built by hand, short enough to stop inside their own headers.
//
// Fuzzing a real frame cannot reach these: damaging a block header makes the block loop refuse
// it before the literals header is ever read, so the only way to truncate a literals header is
// to declare a block that is shorter than one. Every first byte selects a different kind and
// size format, and so a different width to run out of.
{
  const oneBlock = (body: number[]): Uint8Array => {
    const header = (body.length << 3) | (2 << 1) | 1;      // last block, compressed
    return new Uint8Array([
      0x28, 0xb5, 0x2f, 0xfd, 0x20, 8,                     // magic, single segment, 8 bytes out
      header & 0xff, (header >>> 8) & 0xff, (header >>> 16) & 0xff,
      ...body,
    ]);
  };
  ignoringTraps(() => m.decompress(oneBlock([])));       // a block with no body at all
  for (let first = 0; first < 16; first++) {
    for (let n = 0; n <= 10; n++) {
      const body = [first];
      for (let i = 1; i < n; i++) body.push(0x00);
      ignoringTraps(() => m.decompress(oneBlock(body)));
      const filled = [first];
      for (let i = 1; i < n; i++) filled.push(0xff);
      ignoringTraps(() => m.decompress(oneBlock(filled)));
    }
  }
  // A literals section whose tree description uses up the whole section, leaving no stream —
  // and sequence sections that stop inside their own count, mode byte or RLE table byte.
  for (let treeBytes = 1; treeBytes <= 6; treeBytes++) {
    for (let comp = 1; comp <= 8; comp++) {
      // kind 2, size format 0: a three-byte header with 10-bit regenerated and compressed sizes.
      const b0 = 0x02 | (0 << 2) | ((8 & 15) << 4);
      const b1 = (8 >>> 4) | ((comp & 63) << 6);
      const b2 = comp >>> 2;
      const body = [b0, b1, b2, 128 + treeBytes];
      for (let i = 0; i < treeBytes; i++) body.push(0x11);
      ignoringTraps(() => m.decompress(oneBlock(body)));
    }
  }
  for (const tail of [[0x80], [0xff], [0xff, 0x01], [0x01], [0x01, 0x00], [0x01, 0x24], [0x01, 0x24, 0x00]]) {
    // A raw literals section of length zero, then a sequences section that stops early.
    ignoringTraps(() => m.decompress(oneBlock([0x00, ...tail])));
  }

  // The repeat-offset slot that cannot be filled.
  //
  // Every code in RLE mode, so the symbols are fixed and no state bits are read: literal length
  // code 0 (no literals), match length code 0, offset code 1 with its one extra bit set. That
  // makes the offset value 3, and with no literals the numbering shifts to "the most recent
  // offset, minus one" — which at the start of a frame is 1 - 1. There is nothing one byte
  // before the beginning, so the block has to be refused.
  //
  // Reachable only from a stream no encoder would write, and only as the *first* sequence, so
  // fuzzing a real frame never lands on it.
  ignoringTraps(() => m.decompress(oneBlock([
    0x00,        // raw literals, none of them
    0x01,        // one sequence
    0x54,        // literal length, offset and match length all in RLE mode
    0x00,        // literal length code 0
    0x01,        // offset code 1
    0x00,        // match length code 0
    0x03,        // one usable bit, set: the offset code's extra bit
  ])));

  // Literals headers that are complete but claim sizes the block cannot hold, so the refusal
  // is about the section rather than about running out of bytes.
  for (const claim of [[0x02, 0xff, 0xff], [0x06, 0xff, 0xff], [0x0a, 0xff, 0xff, 0xff], [0x0e, 0xff, 0xff, 0xff, 0xff]]) {
    for (let extra = 0; extra <= 6; extra++) {
      const body = [...claim];
      for (let i = 0; i < extra; i++) body.push(0x11);
      ignoringTraps(() => m.decompress(oneBlock(body)));
    }
  }
}

// XXH64 directly, for the bounds it refuses — nothing inside a frame can ask for a range
// outside the output, so those are only reachable from a caller.
{
  const xx = fse.mod as unknown as Record<string, unknown>;
  void xx;
  const x = huff.mod as unknown as Record<string, unknown>;
  void x;
}
const hash = await instrument("packages/zstd/src/xxh64.wac");
const hx = hash.mod as unknown as { xxh64(d: Uint8Array, start: number, len: number): bigint };
{
  const d = new Uint8Array(200);
  for (let i = 0; i < d.length; i++) d[i] = (i * 37 + 11) & 0xff;
  for (let n = 0; n <= 140; n++) ignoringTraps(() => hx.xxh64(d, 0, n));
  for (const [start, len] of [[0, 201], [1, 200], [-1, 1], [0, -1], [200, 1]] as [number, number][]) {
    ignoringTraps(() => hx.xxh64(d, start, len));
  }
}

// ── FSE encoding ──────────────────────────────────────────────────────────────
//
// Driven the way the tests drive it — encode a symbol stream, decode it back — because that is
// the only thing that exercises the table build and the backwards writing together. The shapes
// are chosen for the normaliser: distributions where the rounding cannot be settled against the
// largest symbol alone, and alphabets wider than the table.

const fsee = await instrument("packages/zstd/src/fseenc.wac");
const e = fsee.mod as unknown as {
  normalize(counts: Int32Array, maxSymbol: number, total: number, log: number): Int32Array;
  optimalLog(total: number, maxSymbol: number, maxLog: number): number;
  buildCTable(norm: Int32Array, maxSymbol: number, log: number): unknown;
  encodeStep(c: unknown, symbol: number, target: number): { state: number; value: number; bits: number };
  initialState(c: unknown, symbol: number): number;
  writeDescription(o: unknown, norm: Int32Array, maxSymbol: number, log: number): void;
  BitOut: { create(): { write(v: number, n: number): void; finish(): Uint8Array; flush(): Uint8Array } };
};

function encodeRoundTrip(symbols: number[], maxSymbol: number, maxLog: number): void {
  const counts = new Int32Array(maxSymbol + 1);
  for (const s of symbols) counts[s]++;
  const log = e.optimalLog(symbols.length, maxSymbol, maxLog);
  const norm = e.normalize(counts, maxSymbol, symbols.length, log);
  const c = e.buildCTable(norm, maxSymbol, log);

  const body = e.BitOut.create();
  let state = e.initialState(c, symbols[symbols.length - 1]);
  for (let i = symbols.length - 2; i >= 0; i--) {
    const step = e.encodeStep(c, symbols[i], state);
    body.write(step.value, step.bits);
    state = step.state;
  }
  body.write(state, log);
  body.finish();

  const head = e.BitOut.create();
  e.writeDescription(head, norm, maxSymbol, log);
  head.flush();
}

{
  let seed = 0x1234567 | 0;
  const rand = (n: number) => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed % n;
  };
  for (let trial = 0; trial < 200; trial++) {
    const maxSymbol = 1 + rand(50);
    const n = 20 + rand(3000);
    const weights: number[] = [];
    for (let s = 0; s <= maxSymbol; s++) weights.push(rand(10) === 0 ? 0 : 1 + rand(1 << rand(9)));
    const pool: number[] = [];
    for (let s = 0; s <= maxSymbol; s++) for (let k = 0; k < weights[s]; k++) pool.push(s);
    if (pool.length === 0) continue;
    ignoringTraps(() => encodeRoundTrip(Array.from({ length: n }, () => pool[rand(pool.length)]), maxSymbol, 9));
  }
  // Alphabets wider than the smallest table, so the normaliser has to take slots back rather
  // than settle everything against the largest symbol.
  for (const maxSymbol of [40, 60, 100]) {
    const symbols: number[] = [];
    for (let s = 0; s <= maxSymbol; s++) symbols.push(s);
    ignoringTraps(() => encodeRoundTrip(symbols, maxSymbol, 5));
  }
  // Refusals: a symbol with no states, a target outside the table, an empty distribution.
  {
    const norm = e.normalize(Int32Array.from([10, 0, 5]), 2, 15, 5);
    const c = e.buildCTable(norm, 2, 5);
    ignoringTraps(() => e.encodeStep(c, 1, 0));
    ignoringTraps(() => e.initialState(c, 1));
    ignoringTraps(() => e.encodeStep(c, 0, 1000));
    ignoringTraps(() => e.encodeStep(c, 99, 0));
    ignoringTraps(() => e.initialState(c, 99));
  }
  // Descriptions for distributions carrying -1 counts, which this normaliser never produces
  // but the format's own predefined tables are full of.
  for (
    const [counts, log] of [
      [[4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1], 6],
      [[1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1], 5],
      [[30, -1, 16, -1, 16], 6],
    ] as [number[], number][]
  ) {
    const o = e.BitOut.create();
    e.writeDescription(o, Int32Array.from(counts), counts.length - 1, log);
    o.flush();
  }

  // Distributions where the rounding cannot be settled against the largest symbol but *can* be
  // settled at all: enough symbols that they all round up past the table, few enough that the
  // ones with slots to spare can cover it. 21 equal symbols in 32 slots each round to 2, which
  // is 42 — ten too many, and twenty symbols have a slot to give.
  for (const symbols of [21, 25, 30]) {
    const counts = new Int32Array(symbols);
    for (let s = 0; s < symbols; s++) counts[s] = 1000;
    ignoringTraps(() => e.normalize(counts, symbols - 1, 1000 * symbols, 5));
  }
  // The same, but unequal, so the search for who can spare a slot actually compares candidates
  // rather than taking the first.
  for (const symbols of [21, 26]) {
    const counts = new Int32Array(symbols);
    for (let s = 0; s < symbols; s++) counts[s] = 1000 + s * 250;
    let total = 0;
    for (const c of counts) total += c;
    ignoringTraps(() => e.normalize(counts, symbols - 1, total, 5));
    ignoringTraps(() => e.normalize(counts, symbols - 1, total, 6));
  }

  // Alphabets far wider than the table, so the normaliser exhausts its first strategy and has
  // to take slots back one at a time, comparing candidates as it goes.
  for (const maxSymbol of [70, 120, 200]) {
    const counts = new Int32Array(maxSymbol + 1);
    for (let s = 0; s <= maxSymbol; s++) counts[s] = 1 + (s % 3);
    let total = 0;
    for (const c of counts) total += c;
    ignoringTraps(() => e.normalize(counts, maxSymbol, total, 5));
    ignoringTraps(() => e.normalize(counts, maxSymbol, total, 6));
  }

  ignoringTraps(() => e.normalize(new Int32Array(4), 3, 0, 5));
  ignoringTraps(() => e.normalize(new Int32Array(4), 3, 10, 5));
  for (const total of [1, 2, 10, 1000, 100000]) {
    for (const maxSymbol of [1, 5, 100, 255]) e.optimalLog(total, maxSymbol, 9);
  }
}

// ── The encoder ───────────────────────────────────────────────────────────────
//
// Driven over the shapes an encoder actually branches on: nothing to match, everything matching,
// lengths that land on a block boundary or the last few bytes, and incompressible input where
// every block falls back to raw.

const encoder = await instrument("packages/zstd/src/encode.wac");
const en = encoder.mod as unknown as { compress(d: Uint8Array): Uint8Array };

{
  const t = new TextEncoder();
  const noise = (n: number, seed: number) => {
    const o = new Uint8Array(n);
    let x = seed;
    for (let i = 0; i < n; i++) {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      o[i] = x & 0xff;
    }
    return o;
  };

  for (
    const d of [
      new Uint8Array(0), t.encode("x"), t.encode("ab"), t.encode("abc"),
      t.encode("abcdefghijklmnop"), t.encode("abcabc"), t.encode("xyzabcabc"),
      t.encode("hello hello hello hello world"),
      t.encode("the quick brown fox jumps over the lazy dog. ".repeat(300)),
      new Uint8Array(50000).fill(0x61),
      noise(200000, 7),
      // Every literal-length and match-length code width: short runs between long ones.
      t.encode(("z".repeat(300) + "abcdefghijklmnopqrstuvwxyz").repeat(60)),
      // Past a block, exactly a block, and one over.
      t.encode("Lorem ipsum dolor sit amet. ".repeat(9000)),
      noise(131072, 3), noise(131073, 5),
      new Uint8Array([...t.encode("aaaa".repeat(20000)), ...noise(60000, 11)]),
      new Uint8Array(Array.from({ length: 100000 }, (_, i) => i & 0xff)),
      // Literal runs long enough to need each of the three raw-literals header widths.
      noise(20, 1), noise(3000, 2), noise(9000, 4),
    ]
  ) {
    ignoringTraps(() => en.compress(d));
  }

  // Literals sections of each kind. RLE needs one distinct literal byte, Huffman needs a narrow
  // alphabet and a coding that pays, and raw is what is left — including an alphabet too wide
  // for a directly-written tree, which needs matches present or the block falls back to raw and
  // has no literals section at all.
  {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let s2 = 0x1234 | 0;
    const roll = () => { s2 ^= s2 << 13; s2 >>>= 0; s2 ^= s2 >>> 17; s2 ^= s2 << 5; s2 >>>= 0; return s2; };
    // Narrow alphabets at several sizes, so the one-stream and four-stream layouts and each
    // header width are all reached.
    for (const n of [40, 300, 900, 1100, 5000, 40000, 200000]) {
      const parts: string[] = [];
      for (let i = 0; i < n; i++) {
        parts.push(alphabet[(roll() >>> 8) % 64]);
        if (i % 64 === 63) parts.push("\nkey ");
      }
      ignoringTraps(() => en.compress(t.encode(parts.join(""))));
    }
    // An alphabet of exactly two symbols, and one just inside and just outside what a direct
    // description can carry.
    for (const width of [2, 100, 128, 129, 200]) {
      const out = new Uint8Array(30000);
      for (let i = 0; i < out.length; i++) out[i] = (roll() >>> 8) % width;
      // Planted repeats, so there are sequences and therefore a compressed block.
      for (let i = 0; i + 40 < out.length; i += 500) out.set(t.encode("a marker phrase that repeats here    "), i);
      ignoringTraps(() => en.compress(out));
    }
    ignoringTraps(() => en.compress(new Uint8Array(50000).fill(0x61)));
    // Many identical literals rather than three: a marker that matches, separated by a single
    // byte that never does, so every gap contributes one literal and they are all the same. That
    // is what reaches the wider RLE literal headers.
    for (const reps of [40, 900, 9000]) {
      const parts: string[] = [];
      for (let i = 0; i < reps; i++) parts.push("MARKERPHRASE", "x");
      ignoringTraps(() => en.compress(t.encode(parts.join(""))));
    }
  }

  // Longer than the window, so a candidate is found beyond it and rejected.
  {
    const far = new Uint8Array(1300000);
    const mark = t.encode("a distinctive phrase that will be looked for later. ");
    far.set(mark, 0);
    for (let i = mark.length; i < far.length - mark.length; i++) far[i] = 0x41 + (i % 23);
    far.set(mark, far.length - mark.length);
    ignoringTraps(() => en.compress(far));
  }

  // Sequence counts across the one-, two- and three-byte forms. The widest needs more than
  // 32512 sequences in a single block, which means a match every four bytes or so: three bytes
  // that repeat, then one that does not.
  // The literal between matches has to be *unpredictable*, not merely varying: a cycling byte
  // makes the whole cycle repeat, the matcher finds the cycle rather than the three bytes, and
  // a block ends up with a handful of long sequences instead of tens of thousands of short ones.
  for (const reps of [40, 3000, 45000]) {
    const rnd = noise(reps, 12345);
    const out = new Uint8Array(reps * 4);
    for (let i = 0; i < reps; i++) {
      out[i * 4] = 0x61;
      out[i * 4 + 1] = 0x62;
      out[i * 4 + 2] = 0x63;
      out[i * 4 + 3] = rnd[i];
    }
    ignoringTraps(() => en.compress(out));
  }
}

/**
 * Branches this run does not cover, each with the reason and whether it is provable.
 *
 * Two different claims, kept apart on purpose:
 *
 *   - `proven: true` — no input can reach it. A guard that cannot fire is still worth keeping
 *     when what it guards is worse than a wrong answer, but counting it as covered would make
 *     the number meaningless;
 *   - `proven: false` — reachable, and we did not manage to construct the input. That is a gap,
 *     not an exemption, and saying so is the whole point of the distinction. Reading a list of
 *     "unreachable" branches that quietly includes merely-difficult ones is how a coverage
 *     number stops meaning anything.
 *
 * Every entry is checked against the source, so moving the code without moving the entry fails
 * loudly rather than silently excluding the wrong line.
 */
const NOT_COVERED: { file: string; line: number; snippet: string; proven: boolean; why: string }[] = [
  {
    file: "packages/zstd/src/fse.wac",
    line: 146,
    proven: true,
    snippet: "if (remaining < 0) { trap; }",
    why: "The wire form bounds each count by what is left: the field is masked to " +
      "2*threshold-1 and the long branch subtracts max, which together put the count in " +
      "[0, remaining]. Kept because a negative remaining would drive nbBits below zero in the " +
      "narrowing loop, and a zero-width read never advances — a hang rather than a wrong answer.",
  },
  {
    file: "packages/zstd/src/fse.wac",
    line: 263,
    proven: true,
    snippet: "if (len <= 0) { trap; }",
    why: "decompress refuses a description with nothing behind it before constructing a " +
      "BackBits, so the only caller in this package cannot pass a non-positive length. The " +
      "struct is exported for the sequences decoder, which is not written yet and will not " +
      "have that guard for free.",
  },
  {
    file: "packages/zstd/src/encode.wac",
    line: 309,
    proven: true,
    snippet: "while ((1 << log) < need && log < maxLog) {",
    why: "optimalLog floors the log at highBit(top) + 2, so the table is at least four times " +
      "the highest used code — and since a code alphabet has at most top + 1 members, that is " +
      "always more slots than distinct codes. The cap at maxLog cannot bite either: the widest " +
      "alphabet here is match lengths at 53 codes against a 512-slot table. Kept because the " +
      "property it guards belongs to optimalLog rather than to this function, and a code with " +
      "no slot cannot be written at all.",
  },
  {
    file: "packages/zstd/src/encode.wac",
    line: 335,
    proven: false,
    snippet: "} else {",
    why: "The three-byte sequence count needs 32512 sequences in one block, and a 128 KiB " +
      "block holds at most 32768 — every one of them a literal and a three-byte match. The " +
      "closest input synthesised reached 32223: the matcher takes the best of 32 candidates, " +
      "so a match extends past three bytes often enough to lose the margin. Periodic input " +
      "makes it worse, not better, because then the matcher finds the whole cycle as one " +
      "65 KB match. The branch is three lines and mirrors readCount in sequences.wac, which " +
      "is tested — but that is an argument, not a test.",
  },
  {
    file: "packages/zstd/src/huffenc.wac",
    line: 66,
    proven: true,
    snippet: "if (nodes < 2) { trap; }",
    why: "A Huffman code needs two symbols. compressLiterals checks `describable` first, which " +
      "requires two, and build has no other caller now that it is not exported — a section with " +
      "one distinct byte becomes RLE instead. Kept because it is the invariant the tree merge " +
      "depends on, and violating it would loop rather than fail.",
  },
  {
    file: "packages/zstd/src/huffenc.wac",
    line: 186,
    proven: true,
    snippet: "if (count < 1 || count > maxDirectSymbol()) { trap; }",
    why: "Same guard from the other end: `describable` has already bounded the highest symbol " +
      "to 128, which is what a directly-written tree description can carry, and writeTree has " +
      "no other caller. Kept because writing a wider one would produce a header byte that means " +
      "something else entirely.",
  },
  {
    file: "packages/zstd/src/encode.wac",
    line: 370,
    proven: false,
    snippet: "} else if (n < 4096) {",
    why: "The wider RLE literal headers, which need 32 or more literals that are all the same " +
      "byte. Hard to arrange and possibly not worth arranging: literals are what matching " +
      "failed on, and a repeated byte is exactly what matching succeeds on, so the runs that " +
      "would produce them get absorbed into matches instead. Every input tried left three.",
  },
  {
    file: "packages/zstd/src/block.wac",
    line: 139,
    proven: false,
    snippet: "if (h.compressedSize <= 0) { trap; }",
    why: "A treeless literals section claiming no bytes at all. Reaching it needs a frame " +
      "whose first block establishes a Huffman table and whose second is treeless with a " +
      "compressed size of zero — two blocks, hand-built, with a valid Huffman-coded first " +
      "one. Corrupting a real frame does not get there: damaging the size field of a " +
      "treeless section is refused by the block bounds first.",
  },
];

const huffe = await instrument("packages/zstd/src/huffenc.wac");
report([run, fse, huff, hash, fsee, encoder, huffe], "packages/zstd/", { verbose });

let stale = false;
const sources = new Map<string, string[]>();
for (const u of NOT_COVERED) {
  if (!sources.has(u.file)) sources.set(u.file, (await Deno.readTextFile(u.file)).split("\n"));
  const at = sources.get(u.file)![u.line - 1] ?? "";
  if (!at.includes(u.snippet)) {
    console.log(`\n${u.file}:${u.line} no longer holds ${JSON.stringify(u.snippet)} — it holds:\n  ${at.trim()}`);
    stale = true;
  } else {
    const label = u.proven ? "unreachable" : "reachable, NOT COVERED";
    console.log(`\n${label}: ${u.file}:${u.line}  ${u.snippet}\n  ${u.why}`);
  }
}
if (stale) Deno.exit(1);
