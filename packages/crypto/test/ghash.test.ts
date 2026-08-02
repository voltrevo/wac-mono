// GHASH's length refusals.
//
// Only the refusals. The field's algebra — bilinearity, commutativity, the identity and
// zero, associativity — moved to `test/wac/ghash_test.wac`, where the properties need no
// host and no table of expected products.
//
// These stayed because they trap. The long-H case is the one worth keeping sharp: a short
// H traps regardless, because reading the second word runs off the end, but a long one
// does not — so without the check the extra bytes are silently ignored and a caller who
// passed a 20-byte subkey would get the hash of a different one. Found by mutation
// testing rather than by reading.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);
const ghash = mod.ghash as (h: Uint8Array, d: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.replace(/\s/g, "").match(/../g)!.map(h => parseInt(h, 16)));
const xor = (a: Uint8Array, b: Uint8Array) => a.map((v, i) => v ^ b[i]);

/** GHASH over a single block is exactly the field product H·X. */
const mul = (h: Uint8Array, x: Uint8Array) => ghash(h, x);

Deno.test("ghash: rejects input that is not a whole number of blocks", () => {
  const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  const h = new Uint8Array(16).fill(0xAB);
  for (const n of [1, 15, 17, 31]) {
    if (!traps(() => ghash(h, new Uint8Array(n)))) throw new Error(`${n} bytes was accepted`);
  }
  if (!traps(() => ghash(new Uint8Array(15), new Uint8Array(16)))) throw new Error("a 15-byte H was accepted");
  // And too long, which is the case the length check uniquely catches. A short H traps
  // regardless, because reading the second word runs off the end; a long one does not,
  // so without the check the extra bytes are silently ignored and a caller who passed a
  // 20-byte subkey would get a hash of a different one. Found by mutation testing.
  for (const n of [17, 20, 32]) {
    if (!traps(() => ghash(new Uint8Array(n), new Uint8Array(16)))) {
      throw new Error(`a ${n}-byte H was accepted`);
    }
  }
});
