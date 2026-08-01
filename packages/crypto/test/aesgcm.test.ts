// AES-GCM against the McGrew–Viega vectors and against WebCrypto.
//
// WebCrypto implements AES-GCM directly, so unlike ChaCha20-Poly1305 there is a
// host oracle for the whole construction. The cases worth forcing are the ones
// GCM's bookkeeping gets wrong: an IV that is not 96 bits (which takes the
// GHASH path for J0 rather than using the IV directly), empty plaintext, empty
// AAD, and lengths that are not multiples of the block size.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);
const enc = mod.gcmEncrypt as (k: Uint8Array, iv: Uint8Array, p: Uint8Array) => Uint8Array;
const tag = mod.gcmTag as (k: Uint8Array, iv: Uint8Array, a: Uint8Array, c: Uint8Array) => Uint8Array;
const dec = mod.gcmDecrypt as (k: Uint8Array, iv: Uint8Array, a: Uint8Array, c: Uint8Array, t: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.replace(/\s/g, "").match(/../g)?.map(h => parseInt(h, 16)) ?? []);
const cat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
const rejects = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

async function host(key: Uint8Array, iv: Uint8Array, aad: Uint8Array, pt: Uint8Array): Promise<string> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);
  const out = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
    k, pt as BufferSource);
  return hex(new Uint8Array(out));   // ciphertext || tag
}

Deno.test("aes-gcm: the McGrew-Viega test cases", () => {
  const cases: [string, string, string, string, string, string][] = [
    // key, iv, aad, plaintext, ciphertext, tag
    ["00000000000000000000000000000000", "000000000000000000000000", "", "",
     "", "58e2fccefa7e3061367f1d57a4e7455a"],
    ["00000000000000000000000000000000", "000000000000000000000000", "",
     "00000000000000000000000000000000",
     "0388dace60b6a392f328c2b971b2fe78", "ab6e47d42cec13bdf53a67b21257bddf"],
    ["feffe9928665731c6d6a8f9467308308", "cafebabefacedbaddecaf888", "",
     "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255",
     "42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091473f5985",
     "4d5c2af327cd64a62cf35abd2ba6fab4"],
    // Case 4: with AAD, and a plaintext that is not a whole number of blocks.
    ["feffe9928665731c6d6a8f9467308308", "cafebabefacedbaddecaf888", "feedfacedeadbeeffeedfacedeadbeefabaddad2",
     "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
     "42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091",
     "5bc94fbc3221a5db94fae95ae7121a47"],
  ];
  for (const [k, iv, aad, pt, wantCt, wantTag] of cases) {
    const gotCt = enc(unhex(k), unhex(iv), unhex(pt));
    if (hex(gotCt) !== wantCt) throw new Error(`ciphertext:\n  got  ${hex(gotCt)}\n  want ${wantCt}`);
    const gotTag = tag(unhex(k), unhex(iv), unhex(aad), gotCt);
    if (hex(gotTag) !== wantTag) throw new Error(`tag:\n  got  ${hex(gotTag)}\n  want ${wantTag}`);
  }
});

Deno.test("aes-gcm: a non-96-bit IV takes the GHASH path for J0", () => {
  // This path has no host oracle — WebCrypto accepts 96-bit IVs only — so these
  // vectors are the whole check on it, at both a shorter and a much longer IV.
  // Case 5 and 6 of the same suite: 64-bit and 480-bit IVs.
  const key = unhex("feffe9928665731c6d6a8f9467308308");
  const aad = unhex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
  const pt = unhex("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39");
  const ct5 = enc(key, unhex("cafebabefacedbad"), pt);
  if (hex(ct5) !== "61353b4c2806934a777ff51fa22a4755699b2a714fcdc6f83766e5f97b6c742373806900e49f24b22b097544d4896b424989b5e1ebac0f07c23f4598")
    throw new Error(`64-bit IV ciphertext: ${hex(ct5)}`);
  if (hex(tag(key, unhex("cafebabefacedbad"), aad, ct5)) !== "3612d2e79e3b0785561be14aaca2fccb")
    throw new Error(`64-bit IV tag: ${hex(tag(key, unhex("cafebabefacedbad"), aad, ct5))}`);

  // 480-bit IV: long enough that the IV itself spans several GHASH blocks.
  const iv6 = unhex("9313225df88406e555909c5aff5269aa6a7a9538534f7da1e4c303d2a318a728" +
                    "c3c0c95156809539fcf0e2429a6b525416aedbf5a0de6a57a637b39b");
  const ct6 = enc(key, iv6, pt);
  if (hex(ct6) !== "8ce24998625615b603a033aca13fb894be9112a5c3a211a8ba262a3cca7e2ca701e4a9a4fba43c90ccdcb281d48c7c6fd62875d2aca417034c34aee5")
    throw new Error(`480-bit IV ciphertext: ${hex(ct6)}`);
  if (hex(tag(key, iv6, aad, ct6)) !== "619cc5aefffe0bfa462af43c1699d050")
    throw new Error(`480-bit IV tag: ${hex(tag(key, iv6, aad, ct6))}`);
});

Deno.test("aes-gcm: agrees with WebCrypto across key, IV, AAD and message sizes", async () => {
  for (const kn of [16, 24, 32]) {
    const key = new Uint8Array(kn); for (let i = 0; i < kn; i++) key[i] = (i * 19 + 7) & 0xFF;
    // Only 96 bits here: WebCrypto rejects any other IV length for GCM, so the
    // GHASH-derived J0 path cannot be compared against the host and is covered
    // by the published 64-bit and 480-bit IV vectors instead.
    for (const ivn of [12]) {
      const iv = new Uint8Array(ivn); for (let i = 0; i < ivn; i++) iv[i] = (i * 13 + 1) & 0xFF;
      for (const [an, pn] of [[0, 0], [0, 16], [16, 0], [1, 1], [20, 60], [16, 64], [17, 65]]) {
        const aad = new Uint8Array(an); for (let i = 0; i < an; i++) aad[i] = (i * 7 + 3) & 0xFF;
        const pt = new Uint8Array(pn); for (let i = 0; i < pn; i++) pt[i] = (i * 31 + 5) & 0xFF;
        const ct = enc(key, iv, pt);
        const got = hex(cat(ct, tag(key, iv, aad, ct)));
        const want = await host(key, iv, aad, pt);
        if (got !== want) {
          throw new Error(`key ${kn} iv ${ivn} aad ${an} pt ${pn}:\n  got  ${got}\n  want ${want}`);
        }
      }
    }
  }
});

Deno.test("aes-gcm: decrypt round-trips and rejects every tampering", () => {
  const key = unhex("feffe9928665731c6d6a8f9467308308");
  const iv = unhex("cafebabefacedbaddecaf888");
  const aad = unhex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
  const pt = new Uint8Array(97);
  for (let i = 0; i < 97; i++) pt[i] = (i * 29 + 11) & 0xFF;

  const ct = enc(key, iv, pt);
  const t = tag(key, iv, aad, ct);
  if (hex(dec(key, iv, aad, ct, t)) !== hex(pt)) throw new Error("round trip failed");

  const flip = (b: Uint8Array, i: number) => { const c = b.slice(); c[i] ^= 1; return c; };
  if (!rejects(() => dec(key, iv, aad, flip(ct, 0), t))) throw new Error("accepted a flipped ciphertext bit");
  if (!rejects(() => dec(key, iv, aad, flip(ct, 96), t))) throw new Error("accepted a flip in the final partial block");
  if (!rejects(() => dec(key, iv, flip(aad, 0), ct, t))) throw new Error("accepted modified AAD");
  if (!rejects(() => dec(key, iv, aad, ct, flip(t, 15)))) throw new Error("accepted a flipped tag bit");
  if (!rejects(() => dec(flip(key, 0), iv, aad, ct, t))) throw new Error("accepted the wrong key");
  if (!rejects(() => dec(key, flip(iv, 0), aad, ct, t))) throw new Error("accepted the wrong nonce");
  if (!rejects(() => dec(key, iv, aad, ct.slice(0, 96), t))) throw new Error("accepted a truncated ciphertext");
  if (!rejects(() => dec(key, iv, aad, ct, t.slice(0, 15)))) throw new Error("accepted a short tag");
  // Same asymmetry as ChaCha20-Poly1305: a short tag traps whichever way the length
  // check goes, so it never tested the check. A long tag whose first sixteen bytes are
  // right verifies happily without it — tag padding as a forgery. Found by mutation
  // testing rather than by reading the code, which I had done.
  for (const extra of [1, 2, 16]) {
    const padded = new Uint8Array(16 + extra);
    padded.set(t);
    padded.fill(0xAA, 16);
    if (!rejects(() => dec(key, iv, aad, ct, padded))) {
      throw new Error(`accepted a ${16 + extra}-byte tag whose first 16 bytes are valid`);
    }
  }
  if (!rejects(() => enc(key, new Uint8Array(0), pt))) throw new Error("accepted an empty IV");

  // The trailing length fields are what stop a byte crossing the aad/ct boundary.
  const all = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  if (hex(tag(key, iv, all.slice(0, 3), all.slice(3))) === hex(tag(key, iv, all.slice(0, 5), all.slice(5)))) {
    throw new Error("aad/ciphertext boundary is not authenticated");
  }
});

Deno.test("aes-gcm: the counter wraps at 2^32 and never carries higher", () => {
  // SP 800-38D's inc_32 leaves the upper 96 bits alone. A carry that propagated
  // would be unreachable through gcmEncrypt without 2^32 blocks, so it is tested
  // here directly — a mutation that carries the whole 128 bits otherwise passes
  // every other test in this file.
  const inc = mod.gcmInc32 as (c: Uint8Array) => Uint8Array;
  const cases: [string, string][] = [
    // upper 96 bits are arbitrary and must come back unchanged
    ["deadbeefcafebabe0badf00d" + "00000001", "deadbeefcafebabe0badf00d" + "00000002"],
    ["deadbeefcafebabe0badf00d" + "000000ff", "deadbeefcafebabe0badf00d" + "00000100"],
    ["deadbeefcafebabe0badf00d" + "0000ffff", "deadbeefcafebabe0badf00d" + "00010000"],
    ["deadbeefcafebabe0badf00d" + "00ffffff", "deadbeefcafebabe0badf00d" + "01000000"],
    // the wrap: all-ones low word returns to zero, upper bits untouched
    ["deadbeefcafebabe0badf00d" + "ffffffff", "deadbeefcafebabe0badf00d" + "00000000"],
    ["ffffffffffffffffffffffff" + "ffffffff", "ffffffffffffffffffffffff" + "00000000"],
  ];
  for (const [before, after] of cases) {
    const got = hex(inc(unhex(before)));
    if (got !== after) throw new Error(`inc32(${before})\n  got  ${got}\n  want ${after}`);
  }
});

Deno.test("aes-gcm: gcmTag rejects an empty IV too, not just gcmEncrypt", () => {
  // Both exports guard the IV independently. gcmEncrypt's check is exercised above,
  // and a caller that computes a tag without encrypting — verifying someone else's
  // ciphertext, say — reaches only this one. With a zero-length IV, J0 would be
  // GHASH over no blocks, which is a fixed value: every message under that key would
  // share a counter stream.
  const key = unhex("feffe9928665731c6d6a8f9467308308");
  const ct = unhex("42831ec2217774244b7221b784d0d49c");
  if (!rejects(() => tag(key, new Uint8Array(0), new Uint8Array(0), ct))) {
    throw new Error("gcmTag accepted an empty IV");
  }
});
