// HMAC-SHA-256 against RFC 4231's vectors and against WebCrypto.
//
// The key-length boundaries are where HMAC goes wrong: a key shorter than the
// block is zero-padded, one longer is hashed first, and exactly 64 is neither.
// RFC 4231 case 6 uses a 131-byte key precisely for that.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);
const hmac = mod.hmac as (k: Uint8Array, m: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map(h => parseInt(h, 16)));
const utf8 = (s: string) => new TextEncoder().encode(s);

async function host(k: Uint8Array, m: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", k as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, m as BufferSource)));
}

Deno.test("hmac-sha256: RFC 4231 test vectors", () => {
  const cases: [Uint8Array, Uint8Array, string][] = [
    [unhex("0b".repeat(20)), utf8("Hi There"),
     "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"],
    [utf8("Jefe"), utf8("what do ya want for nothing?"),
     "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"],
    [unhex("aa".repeat(20)), unhex("dd".repeat(50)),
     "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"],
    [unhex("0102030405060708090a0b0c0d0e0f10111213141516171819"), unhex("cd".repeat(50)),
     "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b"],
    // Case 6: key longer than the 64-byte block, so it is hashed first.
    [unhex("aa".repeat(131)), utf8("Test Using Larger Than Block-Size Key - Hash Key First"),
     "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"],
    [unhex("aa".repeat(131)),
     utf8("This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm."),
     "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2"],
  ];
  for (const [k, m, want] of cases) {
    const got = hex(hmac(k, m));
    if (got !== want) throw new Error(`key ${k.length}B msg ${m.length}B\n  got  ${got}\n  want ${want}`);
  }
});

Deno.test("hmac-sha256: agrees with WebCrypto across key and message lengths", async () => {
  // 63/64/65 straddle the block boundary in the key path.
  for (const kn of [1, 20, 32, 63, 64, 65, 100, 200]) {
    for (const mn of [0, 1, 55, 56, 64, 100]) {
      const k = new Uint8Array(kn); for (let i = 0; i < kn; i++) k[i] = (i * 7 + 1) & 0xFF;
      const m = new Uint8Array(mn); for (let i = 0; i < mn; i++) m[i] = (i * 13 + 5) & 0xFF;
      const got = hex(hmac(k, m));
      const want = await host(k, m);
      if (got !== want) throw new Error(`key ${kn} msg ${mn}: got ${got}, want ${want}`);
    }
  }
});
