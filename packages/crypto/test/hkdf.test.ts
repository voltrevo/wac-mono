// HKDF's output cap.
//
// Only the cap. The RFC 5869 vectors, the expansion chain rebuilt on the host's HMAC, and
// the "every input changes the output" checks moved to `test/wac/kdf_test.wac`, alongside
// HMAC's own — one file, because HKDF is HMAC used twice and a fault in the primitive
// shows in both.
//
// This stayed because exceeding the cap traps, and a trap unwinds the module rather than
// returning. The counter appended to each block is a single byte starting at 1, so 255
// blocks is the limit and 255*32 = 8160 the largest legal request. Both sides are worth
// pinning: a cap off by one block is invisible at every length the vectors use, and one
// enforced a block early silently refuses output that is well defined.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);
const hkdf = mod.hkdf as (s: Uint8Array, i: Uint8Array, n: Uint8Array, l: number) => Uint8Array;
const extract = mod.hkdfExtract as (s: Uint8Array, i: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.replace(/\s/g, "").match(/../g)?.map(h => parseInt(h, 16)) ?? []);

Deno.test("hkdf: the 255-block output cap, on both sides of the boundary", async () => {
  // The counter appended to each T(i) is a single byte starting at 1, so at most 255
  // blocks can be generated — RFC 5869 §2.3. That makes 255*32 = 8160 the largest
  // legal request and 8161 the first illegal one. Worth pinning on both sides: a cap
  // that is off by one block is invisible at every length the vectors use, and a cap
  // enforced one block early would silently refuse output that is well-defined.
  const ikm = new Uint8Array(32); for (let i = 0; i < 32; i++) ikm[i] = i ^ 0x5A;
  const salt = new Uint8Array(16).fill(0x0C);
  const info = new TextEncoder().encode("cap");
  const LIMIT = 255 * 32;

  const okm = hkdf(salt, ikm, info, LIMIT);
  if (okm.length !== LIMIT) throw new Error(`asked for ${LIMIT}, got ${okm.length}`);

  // WebCrypto enforces the same cap, so the largest legal request is also checked for
  // value rather than only for length — the last block is the one under the counter
  // that would wrap.
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const want = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, key, LIMIT * 8));
  if (hex(okm) !== hex(want)) {
    throw new Error(`at the cap, wac and WebCrypto disagree in the final block:\n` +
      `  got  ...${hex(okm.subarray(LIMIT - 32))}\n  want ...${hex(want.subarray(LIMIT - 32))}`);
  }

  const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  if (!traps(() => hkdf(salt, ikm, info, LIMIT + 1))) {
    throw new Error(`${LIMIT + 1} bytes was accepted, but only 255 blocks can be derived`);
  }
});
