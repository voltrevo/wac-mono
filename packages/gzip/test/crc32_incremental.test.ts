// The incremental CRC against the whole-array one.
//
// `crc32` takes an array a stream does not have, so `crc32Update` folds in a piece at a time.
// The two must agree for every way of cutting the input up — and the way to get this wrong is
// the finalisation: the value carried between calls is the *unfinalised* register, so a caller
// that fed back a finished checksum would invert twice and be wrong by exactly that.

import { wacBind } from "../../../harness/wacBind.ts";

const m = await wacBind("packages/gzip/test/wac/crcprobe.wac") as unknown as {
  whole(d: Uint8Array): number;
  chunked(d: Uint8Array, step: number): number;
};

Deno.test("folding in pieces equals one pass over the whole", () => {
  // The 8-way loop consumes eight bytes at a time with a byte-at-a-time tail, so the sizes
  // that matter are the ones either side of eight and the ones that leave an odd remainder.
  for (const n of [0, 1, 7, 8, 9, 15, 16, 17, 100, 1000, 4096]) {
    const d = new Uint8Array(n);
    for (let i = 0; i < n; i++) d[i] = (i * 37 + 11) & 0xff;
    const want = m.whole(d);
    for (const step of [1, 2, 3, 7, 8, 9, 64, 1000, 1 << 20]) {
      const got = m.chunked(d, step);
      if (got !== want) {
        throw new Error(`${n} bytes in steps of ${step}: got ${got >>> 0}, want ${want >>> 0}`);
      }
    }
  }
});

Deno.test("the empty input is the empty checksum either way", () => {
  const empty = new Uint8Array(0);
  if (m.chunked(empty, 1) !== m.whole(empty)) throw new Error("empty input disagrees");
  if (m.whole(empty) !== 0) throw new Error(`CRC of nothing should be 0, got ${m.whole(empty) >>> 0}`);
});
