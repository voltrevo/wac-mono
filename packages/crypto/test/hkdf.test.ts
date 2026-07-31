// HKDF-SHA-256 against RFC 5869's vectors and against WebCrypto.
//
// The cases that matter are the degenerate ones: an empty salt (which means a
// block of zeros, not "skip the step"), empty info, and an output length that
// is not a multiple of the hash size.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);
const hkdf = mod.hkdf as (s: Uint8Array, i: Uint8Array, n: Uint8Array, l: number) => Uint8Array;
const extract = mod.hkdfExtract as (s: Uint8Array, i: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.replace(/\s/g, "").match(/../g)?.map(h => parseInt(h, 16)) ?? []);

Deno.test("hkdf: RFC 5869 A.1 — basic case", () => {
  const prk = extract(unhex("000102030405060708090a0b0c"), unhex("0b".repeat(22)));
  if (hex(prk) !== "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5") {
    throw new Error(`A.1 prk: ${hex(prk)}`);
  }
  const okm = hkdf(unhex("000102030405060708090a0b0c"), unhex("0b".repeat(22)), unhex("f0f1f2f3f4f5f6f7f8f9"), 42);
  if (hex(okm) !== "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865") {
    throw new Error(`A.1 okm: ${hex(okm)}`);
  }
});

Deno.test("hkdf: RFC 5869 A.2 — longer inputs, 82 bytes out", () => {
  const ikm = unhex(Array.from({length: 80}, (_, i) => i.toString(16).padStart(2, "0")).join(""));
  const salt = unhex(Array.from({length: 80}, (_, i) => (0x60 + i).toString(16).padStart(2, "0")).join(""));
  const info = unhex(Array.from({length: 80}, (_, i) => (0xb0 + i).toString(16).padStart(2, "0")).join(""));
  const okm = hkdf(salt, ikm, info, 82);
  const want = "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c" +
               "59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71" +
               "cc30c58179ec3e87c14c01d5c1f3434f1d87";
  if (hex(okm) !== want) throw new Error(`A.2 okm: ${hex(okm)}`);
});

Deno.test("hkdf: RFC 5869 A.3 — empty salt and info", () => {
  const okm = hkdf(unhex(""), unhex("0b".repeat(22)), unhex(""), 42);
  const want = "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8";
  if (hex(okm) !== want) throw new Error(`A.3 okm: ${hex(okm)}`);
});

Deno.test("hkdf: agrees with WebCrypto over lengths that straddle the hash size", async () => {
  const ikm = new Uint8Array(32); for (let i = 0; i < 32; i++) ikm[i] = i;
  const salt = new Uint8Array(16).fill(0xAB);
  const info = new TextEncoder().encode("wac-mono test");
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  // 1 and 31 are partial, 32 and 64 exact, 33 and 65 spill into a new block.
  for (const n of [1, 31, 32, 33, 63, 64, 65, 200]) {
    const want = hex(new Uint8Array(await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, key, n * 8)));
    const got = hex(hkdf(salt, ikm, info, n));
    if (got !== want) throw new Error(`length ${n}: got ${got}, want ${want}`);
  }
});
