// The curated mutations: deliberate defects chosen because someone knew the algorithm.
//
// Mechanical operators (see operators.ts) cover the systematic edits — a flipped
// comparison, a shifted boundary. These are the ones an operator cannot invent: a
// reversed bit order, a permuted code-length table, a polynomial off by one bit.

import type { Curated } from "./types.ts";

export const CURATED: Curated[] = [
  // ── Control ─────────────────────────────────────────────────────────────────
  // A no-op edit that must SURVIVE. If a staged project failed to build for some
  // unrelated reason, every mutation would report as killed and the whole run
  // would look perfect while proving nothing. This is the check against that:
  // if the control is ever killed, disbelieve the rest of the results.
  {
    name: "control/comment-only-noop",
    file: "packages/gzip/src/crc32.wac",
    find: "// CRC-32 as gzip uses it",
    replace: "// CRC-32 as gzip uses it (control mutation: no behaviour change)",
    mustSurvive: true,
  },

  // ── CRC-32 ──────────────────────────────────────────────────────────────────
  {
    name: "crc32/polynomial",
    file: "packages/gzip/src/crc32.wac",
    find: "crc ^= 0xEDB88320;",
    replace: "crc ^= 0xEDB88321;",
  },
  {
    name: "crc32/initial-value",
    file: "packages/gzip/src/crc32.wac",
    // `u32` since unsigned types landed, and the line appears in both crc32 and
    // crc32Bitwise — mutate the table version.
    find: "u32 crc = 0xFFFFFFFF;",
    nth: 1,
    replace: "u32 crc = 0;",
  },
  {
    name: "crc32/final-inversion",
    file: "packages/gzip/src/crc32.wac",
    // Two occurrences: crc32 and crc32Bitwise. Before `nth` existed this silently
    // mutated the first and left the reference implementation untouched.
    find: "return crc ^ 0xFFFFFFFF;",
    nth: 1,
    replace: "return crc;",
  },
  {
    name: "crc32/shift-distance",
    file: "packages/gzip/src/crc32.wac",
    find: "crc >>= 1;",
    replace: "crc >>= 2;",
  },
  {
    name: "crc32/signed-shift",
    file: "packages/gzip/src/crc32.wac",
    // `crc` is u32 now, so `>>` is already the logical shift and the old mutation
    // (`>>>` to `>>`) no longer expresses anything. The equivalent defect today is
    // reinterpreting as signed first, which drags the sign bit down.
    find: "crc >>= 1;",
    replace: "crc = ((crc as@ i32) >> 1) as@ u32;",
  },

  // ── Bit order ───────────────────────────────────────────────────────────────
  // The classic DEFLATE bug: Huffman codes go MSB-first, everything else
  // LSB-first. Reversing either produces a plausible-looking stream.
  {
    name: "bitwriter/huffman-code-bit-order",
    file: "packages/gzip/src/bitwriter.wac",
    find: "for (i32 i = count - 1; i >= 0; i--) {",
    replace: "for (i32 i = 0; i < count; i++) {",
  },
  {
    name: "bitwriter/align-is-noop",
    file: "packages/gzip/src/bitwriter.wac",
    find: "if (this.bitCount > 0) {",
    replace: "if (false) {",
  },

  // ── LZ77 boundaries ─────────────────────────────────────────────────────────
  {
    name: "lz77/max-match-258-to-257",
    file: "packages/gzip/src/deflate.wac",
    find: "i32 maxMatch()   { return 258; }",
    replace: "i32 maxMatch()   { return 257; }",
    ratioOnly: true,
  },
  {
    name: "lz77/min-match-3-to-4",
    file: "packages/gzip/src/deflate.wac",
    find: "i32 minMatch()   { return 3; }",
    replace: "i32 minMatch()   { return 4; }",
    ratioOnly: true,
  },
  {
    name: "lz77/window-off-by-one",
    file: "packages/gzip/src/deflate.wac",
    find: "if (dist > maxDist()) {",
    replace: "if (dist > maxDist() + 1) {",
  },
  {
    name: "lz77/chain-limit",
    file: "packages/gzip/src/deflate.wac",
    find: "i32 chainLimit() { return 128; }",
    replace: "i32 chainLimit() { return 1; }",
    ratioOnly: true,
  },
  {
    name: "lz77/match-past-end",
    file: "packages/gzip/src/deflate.wac",
    find: "while (len < maxMatch() && pos + len < n",
    replace: "while (len < maxMatch() && pos + len <= n",
  },

  // ── Code tables ─────────────────────────────────────────────────────────────
  {
    name: "tables/length-base-entry",
    file: "packages/gzip/src/tables.wac",
    find: "131,163,195,227,258),",
    replace: "131,163,195,226,258),",
  },
  {
    name: "tables/distance-base-entry",
    file: "packages/gzip/src/tables.wac",
    find: "1025,1537,2049,3073,4097,6145,8193,12289,16385,24577),",
    replace: "1025,1537,2049,3073,4097,6145,8193,12289,16385,24578),",
  },
  {
    name: "tables/length-extra-bits",
    file: "packages/gzip/src/tables.wac",
    find: "i32[](0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0),",
    replace: "i32[](0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,1),",
  },
  {
    name: "tables/length-index-off-by-one",
    file: "packages/gzip/src/tables.wac",
    find: "while (i > 0 && this.lenBase[i] > len) {",
    replace: "while (i > 0 && this.lenBase[i] >= len) {",
  },

  // ── Huffman construction ────────────────────────────────────────────────────
  {
    name: "huffman/canonical-missing-shift",
    file: "packages/gzip/src/huffman.wac",
    find: "code = (code + blCount[bits - 1]) << 1;",
    replace: "code = code + blCount[bits - 1];",
  },
  {
    name: "huffman/length-limit-not-enforced",
    file: "packages/gzip/src/huffman.wac",
    find: "if (longest <= maxBits) {",
    replace: "if (true) {",
  },
  {
    name: "huffman/force-two-disabled",
    file: "packages/gzip/src/huffman.wac",
    find: "while (used < 2 && i < count) {",
    replace: "while (false) {",
  },
  {
    name: "huffman/tie-break-changes-tree",
    file: "packages/gzip/src/huffman.wac",
    find: "} else if (b < 0 || weight[i] < weight[b]) {",
    replace: "} else if (b < 0 || weight[i] <= weight[b]) {",
    ratioOnly: true,
  },

  // ── Dynamic block header ────────────────────────────────────────────────────
  {
    name: "deflate/hlit-off-by-one",
    file: "packages/gzip/src/deflate.wac",
    find: "w.writeBits(hlit - 257, 5); // HLIT",
    replace: "w.writeBits(hlit - 256, 5); // HLIT",
  },
  {
    name: "deflate/hdist-off-by-one",
    file: "packages/gzip/src/deflate.wac",
    find: "w.writeBits(hdist - 1, 5);  // HDIST",
    replace: "w.writeBits(hdist, 5);  // HDIST",
  },
  {
    name: "deflate/hclen-off-by-one",
    file: "packages/gzip/src/deflate.wac",
    find: "w.writeBits(hclen - 4, 4);  // HCLEN",
    replace: "w.writeBits(hclen - 3, 4);  // HCLEN",
  },
  {
    name: "deflate/cl-order-permutation",
    file: "packages/gzip/src/deflate.wac",
    // CL_ORDER became a module-level constant when those landed; it is no longer
    // returned from a function.
    find: "i32[](16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15)",
    replace: "i32[](16, 17, 18, 0, 7, 8, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15)",
  },
  {
    name: "deflate/rle-repeat-base",
    file: "packages/gzip/src/deflate.wac",
    find: "clPush(s, 18, k - 11);",
    replace: "clPush(s, 18, k - 10);",
  },
  {
    name: "deflate/btype-bits",
    file: "packages/gzip/src/deflate.wac",
    // Keyed on the statement rather than the statement plus its comment: the comment's
    // indentation shifted once and took this mutation out of service silently.
    find: "w.writeBits(2, 2);",
    replace: "w.writeBits(1, 2);",
  },

  // ── gzip container ──────────────────────────────────────────────────────────
  {
    name: "gzip/isize-field",
    file: "packages/gzip/src/gzip.wac",
    find: "out.pushU32(isize as@ u32);",
    replace: "out.pushU32((isize + 1) as@ u32);",
    nth: 1,
  },
  {
    // The streaming writer's own copy of the trailer. It appeared with gzipStream and
    // was not covered by anything: the one-shot mutation above stopped applying rather
    // than starting to cover both, which is the failure mode `nth` exists to prevent.
    name: "gzip/isize-field-streaming",
    file: "packages/gzip/src/gzip.wac",
    find: "out.pushU32(isize as@ u32);",
    replace: "out.pushU32((isize + 1) as@ u32);",
    nth: 2,
  },
  {
    name: "gzip/stored-nlen",
    file: "packages/gzip/src/gzip.wac",
    find: "out.pushU16(((~count) & 0xFFFF) as@ u32);",
    replace: "out.pushU16(count as@ u32);",
  },
  {
    name: "gzip/little-endian-u32",
    file: "packages/bytes/src/buf.wac",
    // Signature and casts changed when the buffer moved to `bytes` and `u32` landed.
    find: "void pushU32(this, u32 v) {\n    this.push((v & 0xFF) as@ i32);",
    replace: "void pushU32(this, u32 v) {\n    this.push(((v >> 24) & 0xFF) as@ i32);",
  },

  // ── Inflate ─────────────────────────────────────────────────────────────────
  {
    name: "inflate/crc-check-removed",
    file: "packages/gzip/src/inflate.wac",
    find: "if (crc32(out) != wantCrc) { trap; }",
    replace: "if (false) { trap; }",
  },
  {
    name: "inflate/isize-check-removed",
    file: "packages/gzip/src/inflate.wac",
    find: "if (out.len() != wantSize) { trap; }",
    replace: "if (false) { trap; }",
  },
  {
    // gunzipStream's own trailer check. Not the same expression as the buffered one --
    // a streaming Window has released most of what it wrote, so it counts with total()
    // rather than len() -- which is exactly why it needs its own mutation and why the
    // buffered mutation passing says nothing about it.
    name: "inflate/isize-check-removed-streaming",
    file: "packages/gzip/src/inflate.wac",
    find: "if (out.total() != wantSize) { trap; }",
    replace: "if (false) { trap; }",
  },
  {
    name: "inflate/nlen-check-removed",
    file: "packages/gzip/src/inflate.wac",
    find: "if ((len ^ 0xFFFF) != nlen) { trap; }",
    replace: "if (false) { trap; }",
  },
  {
    name: "inflate/distance-bound",
    file: "packages/gzip/src/inflate.wac",
    find: "if (d > out.base + out.len) { trap; }",
    replace: "if (d > out.base + out.len + 1) { trap; }",
    equivalent: "Same redundancy as inflate/distance-check-removed — the one distance this " +
      "lets through still yields a negative index, which Buf.get and wasm both reject.",
  },
  {
    name: "inflate/distance-check-removed",
    file: "packages/gzip/src/inflate.wac",
    find: "if (d > out.base + out.len) { trap; }",
    replace: "if (false) { trap; }",
    equivalent: "Buf.get's own bounds check still traps on the resulting negative index. " +
      "test/inflate_adversarial.test.ts drives this path; the rejection is just guarded twice.",
  },
  {
    name: "buf/get-bounds-check-removed",
    file: "packages/bytes/src/buf.wac",
    find: "i32 get(const this, i32 i) {\n    if (i < 0 || i >= this.len) { trap; }",
    replace: "i32 get(const this, i32 i) {\n    if (false) { trap; }",
    equivalent: "inflate's distance check rejects the stream before Buf.get is reached.",
  },
  {
    // The decisive experiment: remove BOTH guards at once. If this still
    // survives, the behaviour is enforced a third time by wasm's own array
    // bounds check, and no mutation of the wac source can ever be observable —
    // which makes the two survivors above provably equivalent rather than
    // evidence of a coverage gap.
    name: "inflate+buf/all-distance-guards-removed",
    edits: [
      {
        file: "packages/gzip/src/inflate.wac",
        find: "if (d > out.base + out.len) { trap; }",
        replace: "if (false) { trap; }",
      },
      {
        file: "packages/bytes/src/buf.wac",
        find: "i32 get(const this, i32 i) {\n    if (i < 0 || i >= this.len) { trap; }",
        replace: "i32 get(const this, i32 i) {\n    if (false) { trap; }",
      },
    ],
    equivalent: "wasm's array.get bounds check traps on a negative index regardless, " +
      "so out-of-range distances are rejected even with both source-level guards gone.",
  },
  {
    name: "inflate/magic-check-removed",
    file: "packages/gzip/src/inflate.wac",
    find: "if (gz[0] != 0x1F || gz[1] != 0x8B) { trap; }   // magic",
    replace: "if (false) { trap; }   // magic",
  },
  {
    name: "inflate/bit-read-order",
    file: "packages/gzip/src/inflate.wac",
    // The bit reader was rewritten into peek/skip, so the old readBit loop is gone.
    // Same defect in the new shape: take the high bits of the buffer rather than the
    // low ones, which is LSB-first input read as MSB-first.
    find: "return this.bitBuf & ((1 << count) - 1);",
    replace: "return (this.bitBuf >>> (this.bitCount - count)) & ((1 << count) - 1);",
  },
  {
    name: "inflate/decoder-first-update",
    file: "packages/gzip/src/inflate.wac",
    find: "first = (first + count) << 1;",
    replace: "first = first + count;",
  },
];
