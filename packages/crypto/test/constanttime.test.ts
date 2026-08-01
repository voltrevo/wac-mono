// Does any of this behave differently for different secrets?
//
// `harness/ctTrace.ts` compiles with the compiler's trace mode and compares the ordered
// sequence of branches *and* memory indices between runs that differ only in the secret.
// Read its header for what a pass does and does not mean — in short, a pass is evidence
// for the inputs tested, a failure is definite.
//
// The package is not constant-time and does not claim to be. These tests exist so that
// claim is a *measurement* rather than a disclaimer: what is uniform is pinned so it
// stays uniform, and what leaks is named at the line it leaks on.

import { assertNoSecretDependence, ctModule, firstDivergence, traceOf } from "../../../harness/ctTrace.ts";

const bytes = (m: { exports: Record<string, CallableFunction> }, b: number[]): unknown => {
  const a = m.exports.__bind_arr_u8_new(b.length);
  b.forEach((v, i) => m.exports.__bind_arr_u8_set(a, i, v));
  return a;
};

/** Structured secrets, not random ones: a leak shows at the extremes first. */
const KEYS16 = [
  Array(16).fill(0x00),
  Array(16).fill(0xFF),
  Array.from({ length: 16 }, (_, i) => (i * 37) & 255),
  [0x80, ...Array(15).fill(0)],
];
const KEYS32 = KEYS16.map((k) => [...k, ...k]);
const BLOCK = Array.from({ length: 16 }, (_, i) => i);

Deno.test("sha256 does not vary with its input's content", async () => {
  const m = await ctModule("packages/crypto/src/sha256.wac");
  assertNoSecretDependence(m, KEYS16, (k) => { m.exports.sha256(bytes(m, k)); }, "sha256");
});

Deno.test("chacha20's block function does not vary with the key", async () => {
  const m = await ctModule("packages/crypto/src/chacha20.wac");
  const nonce = Array(12).fill(1);
  assertNoSecretDependence(m, KEYS32, (k) => {
    m.exports.chachaBlock(bytes(m, k), 1, bytes(m, nonce));
  }, "chachaBlock");
});

Deno.test("poly1305 does not vary with the key", async () => {
  const m = await ctModule("packages/crypto/src/poly1305.wac");
  assertNoSecretDependence(m, KEYS32, (k) => {
    m.exports.poly1305(bytes(m, k), bytes(m, BLOCK));
  }, "poly1305");
});

Deno.test("x25519's ladder does not vary with the scalar", async () => {
  // The expensive one — about 1.6 million events per run, which is also the answer to
  // "is the ladder really uniform": it is, over every one of them.
  const m = await ctModule("packages/crypto/src/x25519.wac");
  assertNoSecretDependence(m, KEYS32.slice(0, 2), (k) => {
    m.exports.x25519Base(bytes(m, k));
  }, "x25519Base");
});

// ── Known leaks ───────────────────────────────────────────────────────────────
// Asserted as leaks so that fixing one fails here and forces the README to change
// with it. A README that describes yesterday's side channels is worse than none.

Deno.test("ghash branches on the bits of H (known leak)", async () => {
  const m = await ctModule("packages/crypto/src/ghash.wac");
  const base = traceOf(m, () => m.exports.ghash(bytes(m, KEYS16[0]), bytes(m, BLOCK)));
  const other = traceOf(m, () => m.exports.ghash(bytes(m, KEYS16[1]), bytes(m, BLOCK)));
  const d = firstDivergence(m, base, other);
  if (!d) throw new Error("ghash no longer leaks — update the README and delete this test");
  if (d.kind === "index") throw new Error(`expected a branch leak, got an index one at ${d.file}:${d.line}`);
});

Deno.test("aes indexes its S-box with key-dependent values (known leak)", async () => {
  const m = await ctModule("packages/crypto/src/aes.wac");
  const base = traceOf(m, () => m.exports.aesEncrypt(bytes(m, KEYS16[0]), bytes(m, BLOCK)));
  const other = traceOf(m, () => m.exports.aesEncrypt(bytes(m, KEYS16[1]), bytes(m, BLOCK)));
  const d = firstDivergence(m, base, other);
  if (!d) throw new Error("aes no longer leaks — update the README and delete this test");
  // The point of the whole exercise: this one has no branch to find. Counting
  // branches reports AES's S-box lookup as perfectly uniform.
  if (d.kind !== "index") throw new Error(`expected an index leak, got ${d.kind} at ${d.file}:${d.line}`);
});
