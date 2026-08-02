// AES's key-length refusal.
//
// Only the refusal. FIPS 197's worked examples, agreement with the host at all three key
// sizes, and decryption inverting encryption moved to `test/wac/aes_test.wac`.
//
// This stayed because it traps. It matters more than it looks: AES-128, 192 and 256 differ
// only in the key schedule, so a length the expansion does not recognise would otherwise
// run some number of rounds and produce ciphertext nobody can decrypt.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);
const enc = mod.aesEncrypt as (k: Uint8Array, b: Uint8Array) => Uint8Array;
const dec = mod.aesDecrypt as (k: Uint8Array, b: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.replace(/\s/g, "").match(/../g)!.map(h => parseInt(h, 16)));

/** Raw E(block) under `key`, via CTR with a zero plaintext. */
async function hostBlock(key: Uint8Array, block: Uint8Array): Promise<string> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, "AES-CTR", false, ["encrypt"]);
  const out = await crypto.subtle.encrypt(
    { name: "AES-CTR", counter: block as BufferSource, length: 128 }, k, new Uint8Array(16) as BufferSource);
  return hex(new Uint8Array(out));
}

Deno.test("aes: an unsupported key length traps rather than guessing", () => {
  const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  for (const kn of [0, 1, 15, 17, 20, 31, 33, 64]) {
    if (!traps(() => enc(new Uint8Array(kn), new Uint8Array(16)))) {
      throw new Error(`a ${kn}-byte key was accepted`);
    }
  }
});
