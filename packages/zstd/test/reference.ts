// The reference zstd, in this process.
//
// Node's zlib carries zstd (22.15+) and Deno's `node:zlib` exposes it, which makes this a real oracle
// rather than a second implementation of the same misreading: a frame here came from the reference
// encoder, so a disagreement is ours.
//
// **This used to be two subprocesses.** `test/oracle.mjs` was one, spawned per test file and fed a JSON
// job list over stdin; `test/encode.test.ts` had a second copy inlined as a `node -e` script doing the
// same thing the other way. Both existed because the oracle was assumed to need Node — and it does, but
// Deno *is* Node here for this purpose. So: one module, no spawn, no base64 round-trip through JSON, and
// no second copy to drift.
//
// Everything below is exactly what those two did, including `blockTypes`, which is how a test can say
// which block types it actually covered rather than hoping.

import zlib from "node:zlib";

const z = zlib as unknown as {
  zstdCompressSync(b: Uint8Array, opts?: { params?: Record<number, number> }): Uint8Array;
  zstdDecompressSync(b: Uint8Array): Uint8Array;
  constants: Record<string, number>;
};

export type Encoded = { frame: Uint8Array; blocks: string[] };

/** Compress with the reference encoder. `level` and `checksum` are its own knobs, not ours. */
export function refCompress(
  data: Uint8Array,
  opts: { level?: number; checksum?: boolean } = {},
): Encoded {
  const params: Record<number, number> = {};
  if (opts.level !== undefined) params[z.constants.ZSTD_c_compressionLevel] = opts.level;
  if (opts.checksum) params[z.constants.ZSTD_c_checksumFlag] = 1;
  const frame = z.zstdCompressSync(data, { params });
  return { frame, blocks: blockTypes(frame) };
}

/** Decompress with the reference decoder, or null where it refused the frame. */
export function refDecompress(frame: Uint8Array): Uint8Array | null {
  try {
    return z.zstdDecompressSync(frame);
  } catch {
    return null;
  }
}

/**
 * Walk a frame and name each block's type, so a test can say what it is actually covering.
 *
 * A test asserting "this exercises RLE blocks" is a claim about an encoder's choices, and encoders change
 * their minds between versions. Reading the types out of the frame is the version that cannot go stale.
 */
export function blockTypes(buf: Uint8Array): string[] {
  let p = 4;
  const fhd = buf[p++];
  const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, didFlag = fhd & 3;
  if (!single) p++;
  p += [0, 1, 2, 4][didFlag];
  p += fcsFlag === 0 ? (single ? 1 : 0) : [1, 2, 4, 8][fcsFlag];
  const types: string[] = [];
  for (;;) {
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    const last = h & 1, type = (h >> 1) & 3, size = h >>> 3;
    types.push(["raw", "rle", "compressed", "reserved"][type]);
    p += 3 + (type === 1 ? 1 : size);
    if (last) break;
  }
  return types;
}
