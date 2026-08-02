// AES-GCM's rejections.
//
// Only the rejections. The McGrew-Viega cases, the non-96-bit nonce path, agreement with
// the host across every size, and the 32-bit counter wrap moved to
// `test/wac/aes_test.wac`.
//
// These stayed because they trap, and for GCM that is the half that matters: a mode which
// encrypts correctly and authenticates nothing passes every round trip ever written.

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
