// Poly1305 against a BigInt reference.
//
// Only the differential. The RFC 8439 vector, the forced carries and the clamping rule
// moved to `test/wac/aead_test.wac`, alongside the AEAD they exist to serve.
//
// This one stayed because the reference has nowhere else to live: `node:crypto` exposes
// ChaCha20-Poly1305 but not the bare MAC, and WebCrypto has neither — so a from-scratch
// implementation in BigInt is the only independent check available for Poly1305 on its
// own. Porting it into wac would mean reimplementing 130-bit arithmetic beside the thing
// under test, which is how a differential stops being one.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);
const poly1305 = mod.poly1305 as (k: Uint8Array, m: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.replace(/[\s:]/g, "").match(/../g)!.map(h => parseInt(h, 16)));

const leToBig = (b: Uint8Array) => b.reduceRight((a, x) => (a << 8n) | BigInt(x), 0n);

/** The definition, with no limbs: a = ((a + block) * r) mod (2^130 - 5). */
function reference(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const P = (1n << 130n) - 5n;
  const r = leToBig(key.slice(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = leToBig(key.slice(16, 32));
  let a = 0n;
  for (let i = 0; i < msg.length; i += 16) {
    const chunk = msg.slice(i, i + 16);
    a = ((a + leToBig(chunk) + (1n << BigInt(chunk.length * 8))) * r) % P;
  }
  a = (a + s) & ((1n << 128n) - 1n);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number((a >> BigInt(i * 8)) & 0xFFn);
  return out;
}

Deno.test("poly1305: agrees with the BigInt reference on every length to 3 blocks", () => {
  const key = unhex("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b");
  for (let n = 0; n <= 49; n++) {
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = (i * 53 + 17) & 0xFF;
    const got = hex(poly1305(key, m));
    const want = hex(reference(key, m));
    if (got !== want) throw new Error(`length ${n}: got ${got}, want ${want}`);
  }
});

Deno.test("poly1305: agrees with the reference under fuzzing, including all-ones keys", () => {
  let s = 0x9E3779B9;
  const next = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7FFFFFFF; return s; };
  const rnd = (n: number) => { const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = (next() >>> 11) & 0xFF; return o; };

  for (let k = 0; k < 400; k++) {
    const key = rnd(32);
    const msg = rnd(next() % 300);
    const got = hex(poly1305(key, msg));
    const want = hex(reference(key, msg));
    if (got !== want) throw new Error(`fuzz ${k} (len ${msg.length}) key ${hex(key)}: got ${got}, want ${want}`);
  }

  // Saturated inputs, where carries propagate the whole way and the final
  // subtract triggers — the cases random bytes almost never reach.
  for (const n of [16, 32, 48, 64, 100]) {
    const key = new Uint8Array(32).fill(0xFF);
    const msg = new Uint8Array(n).fill(0xFF);
    const got = hex(poly1305(key, msg));
    const want = hex(reference(key, msg));
    if (got !== want) throw new Error(`all-ones len ${n}: got ${got}, want ${want}`);
  }
});
