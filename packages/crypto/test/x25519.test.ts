// X25519's iterated vector and its length refusal.
//
// Two things that could not move to `test/wac/curve25519_test.wac`. The RFC 7748 vectors,
// the Diffie-Hellman exchange, agreement with the host, clamping, the low-order points and
// the masked top bit are all there.
//
// **The iterated vector** stays because it is a thousand chained scalar multiplications,
// and running it inside a wac test would put a second of work in the middle of a suite
// that otherwise finishes in milliseconds. It is the strongest single check X25519 has —
// a fault anywhere compounds rather than cancelling — and it is worth its second here
// rather than being paid on every wac run.
//
// **The length refusal** stays because it traps, and a trap unwinds the module rather
// than returning.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/crypto/test/wac/curve25519_probe.wac");
const x25519 = mod.x25519 as (k: Uint8Array, u: Uint8Array) => Uint8Array;
const x25519Base = mod.x25519Base as (k: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.replace(/\s/g, "").match(/../g)!.map(h => parseInt(h, 16)));

Deno.test("x25519: the RFC 7748 section 5.2 iterated vectors", () => {
  // k = u = the base point encoding; then repeatedly k, u = X25519(k, u), k.
  let k: Uint8Array<ArrayBuffer> = unhex("0900000000000000000000000000000000000000000000000000000000000000");
  let u: Uint8Array<ArrayBuffer> = k;
  const after = new Map<number, string>([
    [1, "422c8e7a6227d7bca1350b3e2bb7279f7897b87bb6854b783c60e80311ae3079"],
    [1000, "684cf59ba83309552800ef566f2f4d3c1c3887c49360e3875f2eb94d99532c51"],
  ]);
  // The RFC also gives the value after 1,000,000 iterations. At roughly two milliseconds
  // a multiplication that is half an hour, which does not belong in a test suite — the
  // thousandth already depends on every one before it, so the extra decimal places buy
  // less than the runtime costs.
  for (let i = 1; i <= 1000; i++) {
    const next = Uint8Array.from(x25519(k, u));
    u = k;
    k = next;
    const want = after.get(i);
    if (want !== undefined && hex(k) !== want) {
      throw new Error(`iteration ${i}\n  got  ${hex(k)}\n  want ${want}`);
    }
  }
});
Deno.test("x25519: rejects keys that are not 32 bytes", () => {
  const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  const ok = new Uint8Array(32);
  for (const n of [0, 31, 33, 64]) {
    if (!traps(() => x25519(new Uint8Array(n), ok))) throw new Error(`a ${n}-byte scalar was accepted`);
    if (!traps(() => x25519(ok, new Uint8Array(n)))) throw new Error(`a ${n}-byte u-coordinate was accepted`);
  }
});
