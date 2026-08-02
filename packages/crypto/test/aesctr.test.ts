// AES-CTR's IV refusal.
//
// Only the refusal. SP 800-38A's vector, agreement with the host over lengths and key
// sizes, and the counter carrying out of the low word moved to `test/wac/aes_test.wac`.
//
// This stayed because it traps. A counter block is exactly sixteen bytes; a shorter one
// would be padded with whatever followed it in memory, and CTR reuses that value as the
// keystream's starting point for every message under the same key.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);
const ctr = mod.aesCtr as (k: Uint8Array, iv: Uint8Array, d: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.replace(/\s/g, "").match(/../g)!.map(h => parseInt(h, 16)));

async function host(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<string> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, "AES-CTR", false, ["encrypt"]);
  return hex(new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-CTR", counter: iv as BufferSource, length: 128 }, k, data as BufferSource)));
}

Deno.test("aes-ctr: decryption is encryption, and a bad IV traps", () => {
  const key = unhex("2b7e151628aed2a6abf7158809cf4f3c");
  const iv = unhex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff");
  const pt = new Uint8Array(197);
  for (let i = 0; i < 197; i++) pt[i] = (i * 31 + 7) & 0xFF;
  const ct = ctr(key, iv, pt);
  if (hex(ctr(key, iv, ct)) !== hex(pt)) throw new Error("round trip failed");
  if (hex(ct) === hex(pt)) throw new Error("ciphertext equals plaintext");
  const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  if (!traps(() => ctr(key, new Uint8Array(15), pt))) throw new Error("a 15-byte IV was accepted");
  // Too long matters more than too short, and was the case nothing covered. A short IV
  // traps whether or not the length is checked, because the counter block reads past the
  // end — so the short case never tested the check. A *long* IV is read happily: without
  // the length check, `ctr` silently uses the first 16 bytes and ignores the rest, so two
  // callers passing different 20-byte IVs with a shared prefix would reuse a keystream.
  // Mutation testing found this: deleting the check failed no test.
  for (const n of [17, 20, 32]) {
    if (!traps(() => ctr(key, new Uint8Array(n), pt))) throw new Error(`a ${n}-byte IV was accepted`);
  }
});
