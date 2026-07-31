// AES-CTR against WebCrypto, which implements the same full-128-bit counter.
//
// The cases that matter are the boundaries: a partial final block, a length that
// is an exact multiple of 16, and a counter that carries — including the wrap
// from all-ones, where an increment that stops early would desynchronise the
// keystream from the host's.

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

Deno.test("aes-ctr: SP 800-38A F.5.1 — AES-128 CTR", async () => {
  const key = unhex("2b7e151628aed2a6abf7158809cf4f3c");
  const iv = unhex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff");
  const pt = unhex("6bc1bee22e409f96e93d7e117393172a" +
                   "ae2d8a571e03ac9c9eb76fac45af8e51" +
                   "30c81c46a35ce411e5fbc1191a0a52ef" +
                   "f69f2445df4f9b17ad2b417be66c3710");
  const want = "874d6191b620e3261bef6864990db6ce" +
               "9806f66b7970fdff8617187bb9fffdff" +
               "5ae4df3edbd5d35e5b4f09020db03eab" +
               "1e031dda2fbe03d1792170a0f3009cee";
  const got = hex(ctr(key, iv, pt));
  if (got !== want) throw new Error(`F.5.1:\n  got  ${got}\n  want ${want}`);
  // The published vector and the host must agree, or one of them is not CTR.
  if (await host(key, iv, pt) !== want) throw new Error("WebCrypto disagrees with the published vector");
});

Deno.test("aes-ctr: agrees with WebCrypto over lengths and key sizes", async () => {
  for (const kn of [16, 24, 32]) {
    const key = new Uint8Array(kn); for (let i = 0; i < kn; i++) key[i] = (i * 23 + 5) & 0xFF;
    const iv = new Uint8Array(16); for (let i = 0; i < 16; i++) iv[i] = (i * 11) & 0xFF;
    for (const n of [0, 1, 15, 16, 17, 31, 32, 33, 64, 100, 257]) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = (i * 37 + 9) & 0xFF;
      const got = hex(ctr(key, iv, data));
      const want = await host(key, iv, data);
      if (got !== want) throw new Error(`key ${kn} len ${n}: got ${got}, want ${want}`);
    }
  }
});

Deno.test("aes-ctr: the counter carries, including from all-ones", async () => {
  const key = unhex("2b7e151628aed2a6abf7158809cf4f3c");
  const data = new Uint8Array(80);
  for (let i = 0; i < 80; i++) data[i] = i;
  // Each of these forces a carry within the first few blocks; the last wraps.
  for (const ivHex of [
    "000000000000000000000000000000fe",
    "0000000000000000000000000000ffff",
    "00000000000000000000000000ffffff",
    "ffffffffffffffffffffffffffffffff",
  ]) {
    const iv = unhex(ivHex);
    const got = hex(ctr(key, iv, data));
    const want = await host(key, iv, data);
    if (got !== want) throw new Error(`iv ${ivHex}: got ${got}, want ${want}`);
  }
});

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
});
