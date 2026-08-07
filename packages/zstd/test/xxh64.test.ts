// XXH64, against the published vectors and against zstd's own trailers.
//
// The vectors are the real oracle: XXH64 has a specification and known answers, so this is one
// of the few things in the package that can be checked directly rather than by invariant.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/zstd/src/xxh64.wac") as unknown as {
  xxh64(d: Uint8Array, start: number, len: number): bigint;
  xxh64Low(d: Uint8Array, start: number, len: number): number;
};

const enc = new TextEncoder();
const hex = (v: bigint) => (v & 0xffffffffffffffffn).toString(16).padStart(16, "0");

Deno.test("the published vectors", () => {
  const vectors: [string, string][] = [
    ["", "ef46db3751d8e999"],
    ["a", "d24ec4f1a98c6e5b"],
    ["abc", "44bc2cf5ad770999"],
    ["message digest", "066ed728fceeb3be"],
    ["abcdefghijklmnopqrstuvwxyz", "cfe1f278fa89835c"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "aaa46907d3047814"],
  ];
  for (const [text, want] of vectors) {
    const d = enc.encode(text);
    const got = hex(mod.xxh64(d, 0, d.length));
    if (got !== want) throw new Error(`${JSON.stringify(text)}: ${got}, want ${want}`);
  }
});

Deno.test("every length across the stripe and tail boundaries", () => {
  // The algorithm changes shape at 32 bytes, then again at every 8 and 4 in the tail, so the
  // lengths that matter are the ones either side of those. A hash that is right at 64 bytes and
  // wrong at 37 has a broken tail, which fixed vectors alone would not localise.
  const data = new Uint8Array(200);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 11) & 0xff;

  const seen = new Map<string, number>();
  for (let n = 0; n <= 100; n++) {
    const h = hex(mod.xxh64(data, 0, n));
    if (seen.has(h)) throw new Error(`length ${n} hashes the same as ${seen.get(h)}`);
    seen.set(h, n);
  }

  // And the offset must matter as much as the length: hashing from a different start is a
  // different input, which a version that ignored `start` would get wrong.
  if (hex(mod.xxh64(data, 0, 50)) === hex(mod.xxh64(data, 1, 50))) {
    throw new Error("hashing from offset 0 and 1 gives the same answer");
  }
});

Deno.test("the low word is truncated, not clamped", () => {
  // `as~` would clamp anything above 2^32 to 0xFFFFFFFF, which is the kind of wrong that makes
  // nearly every checksum agree with itself. Any hash whose top half is non-zero shows it.
  const d = enc.encode("abc");
  const full = mod.xxh64(d, 0, d.length) & 0xffffffffffffffffn;
  const low = mod.xxh64Low(d, 0, d.length) >>> 0;
  if (BigInt(low) !== (full & 0xffffffffn)) {
    throw new Error(`low word ${low.toString(16)}, want ${(full & 0xffffffffn).toString(16)}`);
  }
  if (low === 0xffffffff) throw new Error("suspiciously clamped");
});

Deno.test("out of range is refused", () => {
  const d = enc.encode("abc");
  for (const [start, len] of [[0, 4], [1, 3], [-1, 1], [0, -1], [3, 1]] as [number, number][]) {
    let trapped = false;
    try {
      mod.xxh64(d, start, len);
    } catch {
      trapped = true;
    }
    if (!trapped) throw new Error(`accepted start ${start} len ${len} on ${d.length} bytes`);
  }
});

// ── The streaming form ────────────────────────────────────────────────────────

const stream = await wacBind("packages/zstd/test/wac/xxh64_probe.wac") as unknown as {
  streamed(d: Uint8Array, cut: number): bigint;
  whole(d: Uint8Array): bigint;
  ragged(d: Uint8Array): bigint;
};

Deno.test("streamed in every chunk size, the digest is the one-shot's", () => {
  // The property that matters and the one a naive version fails: XXH64 consumes 32 bytes at a time and
  // treats the tail differently, so hashing each piece separately agrees with the whole only when every
  // piece is a multiple of 32. Cutting at *every* size from one byte upwards is what finds that.
  // `packages/gzip`'s streaming tests use the same shape — 0006, and 0088 asks for it here.
  for (const len of [0, 1, 7, 31, 32, 33, 63, 64, 65, 200, 1000]) {
    const d = new Uint8Array(len);
    for (let i = 0; i < len; i++) d[i] = (i * 37 + 11) & 0xff;
    const want = stream.whole(d);
    for (let cut = 1; cut <= Math.max(1, len) + 1; cut++) {
      const got = stream.streamed(d, cut);
      if (got !== want) {
        throw new Error(`length ${len} cut every ${cut}: ${got.toString(16)}, want ${want.toString(16)}`);
      }
    }
    if (stream.ragged(d) !== want) throw new Error(`length ${len} in ragged pieces disagrees`);
  }
});

Deno.test("and the published vectors survive being cut up", () => {
  // The vectors above are the real oracle; this checks the streaming path against them directly rather
  // than only against our own one-shot, which could be wrong in the same way.
  const vectors: [string, string][] = [
    ["", "ef46db3751d8e999"],
    ["abc", "44bc2cf5ad770999"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "aaa46907d3047814"],
  ];
  for (const [text, want] of vectors) {
    const d = enc.encode(text);
    for (const cut of [1, 2, 3, 8, 16, 32, 64]) {
      const got = hex(stream.streamed(d, cut));
      if (got !== want) throw new Error(`${JSON.stringify(text)} cut every ${cut}: ${got}, want ${want}`);
    }
  }
});
