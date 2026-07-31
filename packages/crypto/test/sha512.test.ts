// SHA-512 and SHA-384 against WebCrypto and the published vectors.
//
// The block is 128 bytes here rather than 64, so the padding boundaries move:
// 111/112 are the interesting pair, where the 17 bytes of terminator and length
// no longer fit alongside the message and a second block appears.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);
const sha512 = mod.sha512 as (m: Uint8Array) => Uint8Array;
const sha384 = mod.sha384 as (m: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const utf8 = (s: string) => new TextEncoder().encode(s);
async function host(alg: string, m: Uint8Array) {
  return hex(new Uint8Array(await crypto.subtle.digest(alg, m as BufferSource)));
}

Deno.test("sha512: the published NIST vectors", () => {
  const cases: [string, string][] = [
    ["", "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce" +
         "47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"],
    ["abc", "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
            "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"],
    ["abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
     "8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018" +
     "501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909"],
  ];
  for (const [m, want] of cases) {
    const got = hex(sha512(utf8(m)));
    if (got !== want) throw new Error(`sha512(${JSON.stringify(m.slice(0, 12))}…)\n  got  ${got}\n  want ${want}`);
  }
});

Deno.test("sha384: the published NIST vectors", () => {
  const cases: [string, string][] = [
    ["", "38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b"],
    ["abc", "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7"],
  ];
  for (const [m, want] of cases) {
    const got = hex(sha384(utf8(m)));
    if (got !== want) throw new Error(`sha384(${JSON.stringify(m)}): got ${got}`);
  }
});

Deno.test("sha512: a million 'a' — the long NIST vector", () => {
  const got = hex(sha512(new Uint8Array(1_000_000).fill(0x61)));
  const want = "e718483d0ce769644e2e42c7bc15b4638e1f98b13b2044285632a803afa973eb" +
               "de0ff244877ea60a4cb0432ce577c31beb009c5c2c49aa2e4eadb217ad8cc09b";
  if (got !== want) throw new Error(`million-a: got ${got}`);
});

Deno.test("sha512/384: agree with WebCrypto through two blocks", async () => {
  for (let n = 0; n <= 260; n++) {
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = (i * 37 + 11) & 0xFF;
    const g512 = hex(sha512(m));
    const w512 = await host("SHA-512", m);
    if (g512 !== w512) throw new Error(`sha512 length ${n}: got ${g512}, want ${w512}`);
    const g384 = hex(sha384(m));
    const w384 = await host("SHA-384", m);
    if (g384 !== w384) throw new Error(`sha384 length ${n}: got ${g384}, want ${w384}`);
  }
});

Deno.test("sha384 is not a truncated sha512", () => {
  // Different initial state, so the first 48 bytes must differ.
  const m = utf8("the initial values are what distinguish them");
  if (hex(sha384(m)) === hex(sha512(m)).slice(0, 96)) {
    throw new Error("sha384 looks like a truncation of sha512 — wrong initial state");
  }
});
