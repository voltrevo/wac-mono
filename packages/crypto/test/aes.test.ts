// AES against FIPS 197's worked examples and against WebCrypto.
//
// WebCrypto exposes no raw block cipher, but AES-CTR with a counter block B and
// an all-zero plaintext returns E(B) xor 0 — the raw encryption of B. That makes
// the host an oracle for the primitive itself, not just for a mode.

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

Deno.test("aes: FIPS 197 appendix B and C", () => {
  // C.1 — AES-128
  const c1k = unhex("000102030405060708090a0b0c0d0e0f");
  const pt = unhex("00112233445566778899aabbccddeeff");
  if (hex(enc(c1k, pt)) !== "69c4e0d86a7b0430d8cdb78070b4c55a") throw new Error(`C.1: ${hex(enc(c1k, pt))}`);
  // C.2 — AES-192
  const c2k = unhex("000102030405060708090a0b0c0d0e0f1011121314151617");
  if (hex(enc(c2k, pt)) !== "dda97ca4864cdfe06eaf70a0ec0d7191") throw new Error(`C.2: ${hex(enc(c2k, pt))}`);
  // C.3 — AES-256
  const c3k = unhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  if (hex(enc(c3k, pt)) !== "8ea2b7ca516745bfeafc49904b496089") throw new Error(`C.3: ${hex(enc(c3k, pt))}`);
  // Appendix B, the worked example with a different key and plaintext.
  const bk = unhex("2b7e151628aed2a6abf7158809cf4f3c");
  const bp = unhex("3243f6a8885a308d313198a2e0370734");
  if (hex(enc(bk, bp)) !== "3925841d02dc09fbdc118597196a0b32") throw new Error(`B: ${hex(enc(bk, bp))}`);
});

Deno.test("aes: decryption inverts encryption at all three key sizes", () => {
  for (const kn of [16, 24, 32]) {
    const key = new Uint8Array(kn);
    for (let i = 0; i < kn; i++) key[i] = (i * 17 + 3) & 0xFF;
    for (let t = 0; t < 20; t++) {
      const pt = new Uint8Array(16);
      for (let i = 0; i < 16; i++) pt[i] = (i * 31 + t * 7) & 0xFF;
      const ct = enc(key, pt);
      if (hex(ct) === hex(pt)) throw new Error(`key ${kn}: ciphertext equals plaintext`);
      if (hex(dec(key, ct)) !== hex(pt)) throw new Error(`key ${kn} trial ${t}: round trip failed`);
    }
  }
});

Deno.test("aes: agrees with WebCrypto on random keys and blocks", async () => {
  let s = 0x1234567;
  const rnd = (n: number) => {
    const o = new Uint8Array(n);
    for (let i = 0; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) & 0x7FFFFFFF; o[i] = (s >>> 15) & 0xFF; }
    return o;
  };
  for (const kn of [16, 24, 32]) {
    for (let t = 0; t < 25; t++) {
      const key = rnd(kn), block = rnd(16);
      const got = hex(enc(key, block));
      const want = await hostBlock(key, block);
      if (got !== want) throw new Error(`key ${kn} trial ${t}: got ${got}, want ${want}`);
    }
  }
});

Deno.test("aes: an unsupported key length traps rather than guessing", () => {
  const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  for (const kn of [0, 1, 15, 17, 20, 31, 33, 64]) {
    if (!traps(() => enc(new Uint8Array(kn), new Uint8Array(16)))) {
      throw new Error(`a ${kn}-byte key was accepted`);
    }
  }
});
