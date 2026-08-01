// Keccak-f[1600], SHA-3 and SHAKE, against two independent implementations.
//
// The oracles are split by necessity and it works out well. WebCrypto has SHA3-256 and
// SHA3-512 but no SHAKE; OpenSSL 3.5.7 has all four. So the fixed-output functions get
// checked against a browser engine and the extendable-output ones against a C library,
// which between them is a wider net than either alone.
//
// Lengths matter more here than in most hash tests. A sponge has a *rate* — 136 bytes
// for SHA3-256 and SHAKE256, 72 for SHA3-512, 168 for SHAKE128 — and the padding is only
// interesting at the boundaries: an input one byte short of a block puts the domain byte
// and the final bit in the same byte, which is the case a padding written as three
// separate steps gets wrong. Every rate is straddled from both sides.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/crypto/test/wac/keccak_probe.wac");
const sha3_256 = mod.k256 as (m: Uint8Array) => Uint8Array;
const sha3_512 = mod.k512 as (m: Uint8Array) => Uint8Array;
const shake128 = mod.x128 as (m: Uint8Array, n: number) => Uint8Array;
const shake256 = mod.x256 as (m: Uint8Array, n: number) => Uint8Array;
const permuteZero = mod.permuteZero as () => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const bytes = (n: number, seed = 0) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + seed) & 0xFF);

/**
 * OpenSSL 3.5.7, built from source by `tools/openssl35.sh`.
 *
 * The system OpenSSL is 3.0.13, which has neither ML-KEM nor an `xoflen` on dgst. The
 * SHAKE test below is skipped rather than failed when the built one is absent: it is a
 * reference this repo does not ship, and a test that fails because an optional tool is
 * missing teaches people to ignore failures.
 */
const OPENSSL = Deno.env.get("OPENSSL35") ?? "/tmp/ossl/openssl-openssl-3.5.7/apps/openssl";
const HAVE_OPENSSL35 = (() => {
  try {
    return Deno.statSync(OPENSSL).isFile;
  } catch {
    return false;
  }
})();

async function opensslXof(alg: "shake128" | "shake256", msg: Uint8Array, outLen: number): Promise<string> {
  const p = new Deno.Command(OPENSSL, {
    args: ["dgst", `-${alg}`, "-xoflen", String(outLen), "-r"],
    stdin: "piped", stdout: "piped", stderr: "piped",
  }).spawn();
  const w = p.stdin.getWriter();
  await w.write(msg);
  await w.close();
  const { stdout, stderr, code } = await p.output();
  if (code !== 0) throw new Error(`openssl: ${new TextDecoder().decode(stderr)}`);
  return new TextDecoder().decode(stdout).trim().split(" ")[0];
}

Deno.test("keccak: the permutation of an all-zero state", () => {
  // The narrowest check available, and the one that isolates the permutation from the
  // sponge around it. If the rho offsets or the pi permutation were transcribed the wrong
  // way round — the failure this file's derived tables exist to avoid — every other test
  // would fail and none would say why.
  // Sixteen bytes, not more. A longer prefix was written from memory here and was wrong
  // past byte fifteen; the sixteen that matched are kept because agreeing by chance on
  // 128 bits is not a thing that happens, and the rest was removed rather than adjusted
  // to whatever the implementation happened to produce — which would have made this a
  // test of nothing.
  const want = "e7dde140798f25f18a47c033f9ccd584";
  if (!hex(permuteZero()).startsWith(want)) {
    throw new Error(`keccakF(0):\n  got  ${hex(permuteZero()).slice(0, 32)}\n  want ${want}`);
  }
});

Deno.test("keccak: SHA3-256 and SHA3-512 agree with WebCrypto", async () => {
  for (const [fn, alg, rate] of [[sha3_256, "SHA3-256", 136], [sha3_512, "SHA3-512", 72]] as const) {
    // Every rate boundary from both sides, plus the empty input and a multi-block one.
    for (const n of [0, 1, 2, rate - 2, rate - 1, rate, rate + 1, 2 * rate - 1, 2 * rate, 2 * rate + 1, 500]) {
      const msg = bytes(n, n);
      const got = hex(fn(msg));
      const want = hex(new Uint8Array(await crypto.subtle.digest(alg, msg as BufferSource)));
      if (got !== want) throw new Error(`${alg} at ${n} bytes\n  got  ${got}\n  want ${want}`);
    }
  }
});

Deno.test({
  name: "keccak: SHAKE128 and SHAKE256 agree with OpenSSL",
  ignore: !HAVE_OPENSSL35,
  fn: async () => {
  // WebCrypto has no SHAKE, so this is the only differential available for the two
  // functions ML-KEM leans on hardest — the matrix comes out of SHAKE128 and the noise
  // out of SHAKE256, both squeezed far past one block.
  for (const [fn, alg, rate] of [[shake128, "shake128", 168], [shake256, "shake256", 136]] as const) {
    for (const inLen of [0, 1, rate - 1, rate, rate + 1, 300]) {
      const msg = bytes(inLen, inLen);
      // Output lengths that cross the squeeze boundary, which is where a sponge that
      // permutes before reading rather than after diverges.
      for (const outLen of [1, 31, 32, rate - 1, rate, rate + 1, 2 * rate, 400]) {
        const got = hex(fn(msg, outLen));
        const want = await opensslXof(alg, msg, outLen);
        if (got !== want) {
          throw new Error(`${alg} in=${inLen} out=${outLen}\n  got  ${got.slice(0, 80)}\n  want ${want.slice(0, 80)}`);
        }
      }
    }
    }
  },
});

Deno.test("keccak: a longer squeeze extends a shorter one", () => {
  // A sponge's output is a stream: asking for more bytes must not change the ones
  // already produced. An implementation that re-permutes from the start, or that mixes
  // the requested length into the state, would pass every fixed-length comparison above
  // and fail this.
  const msg = bytes(50, 3);
  const long128 = shake128(msg, 512);
  const long256 = shake256(msg, 512);
  for (const n of [1, 17, 168, 169, 336, 511]) {
    if (hex(shake128(msg, n)) !== hex(long128.subarray(0, n))) {
      throw new Error(`shake128 output changed when asked for ${n} bytes`);
    }
    if (hex(shake256(msg, n)) !== hex(long256.subarray(0, n))) {
      throw new Error(`shake256 output changed when asked for ${n} bytes`);
    }
  }
});

Deno.test("keccak: the domain separation actually separates", () => {
  // SHA3-256 and SHAKE256 share a rate and differ only in the padding's first byte. If
  // that byte were dropped or shared, a SHAKE256 truncated to 32 bytes would equal the
  // SHA3-256 of the same input — which is exactly the collapse domain separation exists
  // to prevent, and which no comparison against a single algorithm would notice.
  for (const n of [0, 1, 135, 136, 200]) {
    const msg = bytes(n, 9);
    if (hex(sha3_256(msg)) === hex(shake256(msg, 32))) {
      throw new Error(`SHA3-256 and SHAKE256 agree at ${n} bytes; the domain byte is not applied`);
    }
  }
});
