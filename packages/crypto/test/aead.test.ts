// ChaCha20-Poly1305 against RFC 8439 §2.8.2's worked example, plus the
// tamper cases — which are the ones that matter. An AEAD that encrypts
// correctly but authenticates nothing passes every round-trip test.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);
const enc = mod.aeadEncrypt as (k: Uint8Array, n: Uint8Array, p: Uint8Array) => Uint8Array;
const tag = mod.aeadTag as (k: Uint8Array, n: Uint8Array, a: Uint8Array, c: Uint8Array) => Uint8Array;
const dec = mod.aeadDecrypt as (k: Uint8Array, n: Uint8Array, a: Uint8Array, c: Uint8Array, t: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.replace(/[\s:]/g, "").match(/../g)!.map(h => parseInt(h, 16)));
const rejects = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

const KEY = unhex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
const NONCE = unhex("070000004041424344454647");
const AAD = unhex("50515253c0c1c2c3c4c5c6c7");
const PLAIN = new TextEncoder().encode(
  "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");

Deno.test("aead: RFC 8439 §2.8.2 ciphertext and tag", () => {
  const ct = enc(KEY, NONCE, PLAIN);
  const wantCt =
    "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6" +
    "3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36" +
    "92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc" +
    "3ff4def08e4b7a9de576d26586cec64b6116";
  if (hex(ct) !== wantCt) throw new Error(`ciphertext:\n  got  ${hex(ct)}\n  want ${wantCt}`);

  const t = tag(KEY, NONCE, AAD, ct);
  if (hex(t) !== "1ae10b594f09e26a7e902ecbd0600691") throw new Error(`tag: ${hex(t)}`);
});

Deno.test("aead: decrypt returns the plaintext", () => {
  const ct = enc(KEY, NONCE, PLAIN);
  const t = tag(KEY, NONCE, AAD, ct);
  if (hex(dec(KEY, NONCE, AAD, ct, t)) !== hex(PLAIN)) throw new Error("round trip failed");
});

Deno.test("aead: every tampering is rejected", () => {
  const ct = enc(KEY, NONCE, PLAIN);
  const t = tag(KEY, NONCE, AAD, ct);

  const bitFlip = (b: Uint8Array, i: number) => { const c = b.slice(); c[i] ^= 1; return c; };

  if (!rejects(() => dec(KEY, NONCE, AAD, bitFlip(ct, 0), t))) throw new Error("accepted a flipped first ciphertext bit");
  if (!rejects(() => dec(KEY, NONCE, AAD, bitFlip(ct, ct.length - 1), t))) throw new Error("accepted a flipped last ciphertext bit");
  if (!rejects(() => dec(KEY, NONCE, bitFlip(AAD, 0), ct, t))) throw new Error("accepted modified associated data");
  if (!rejects(() => dec(KEY, NONCE, AAD, ct, bitFlip(t, 15)))) throw new Error("accepted a flipped tag bit");
  if (!rejects(() => dec(bitFlip(KEY, 0), NONCE, AAD, ct, t))) throw new Error("accepted the wrong key");
  if (!rejects(() => dec(KEY, bitFlip(NONCE, 0), AAD, ct, t))) throw new Error("accepted the wrong nonce");
  if (!rejects(() => dec(KEY, NONCE, AAD, ct, t.slice(0, 15)))) throw new Error("accepted a short tag");
  // A tag that is too *long* is the case the length check actually earns its keep on, and
  // nothing tested it. A short tag traps either way, because the comparison loop reads
  // past the end — so the short case exercised the check without testing it. A long tag
  // does not: the loop compares the first sixteen bytes, finds them correct, and returns
  // the plaintext. Anyone holding a valid tag could append arbitrary bytes and still
  // verify. Mutation testing found this; deleting the check failed no test.
  for (const extra of [1, 2, 16]) {
    const padded = new Uint8Array(16 + extra);
    padded.set(t);
    padded.fill(0xAA, 16);
    if (!rejects(() => dec(KEY, NONCE, AAD, ct, padded))) {
      throw new Error(`accepted a ${16 + extra}-byte tag whose first 16 bytes are valid`);
    }
  }
  // Truncating the ciphertext changes the length field inside the MAC input.
  if (!rejects(() => dec(KEY, NONCE, AAD, ct.slice(0, ct.length - 1), t))) throw new Error("accepted a truncated ciphertext");
});

Deno.test("aead: the length fields stop bytes moving between aad and ciphertext", () => {
  // Same concatenation, split differently. Without the trailing lengths in the
  // MAC input these two would authenticate identically.
  const all = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const t1 = tag(KEY, NONCE, all.slice(0, 3), all.slice(3));
  const t2 = tag(KEY, NONCE, all.slice(0, 5), all.slice(5));
  if (hex(t1) === hex(t2)) throw new Error("aad/ciphertext boundary is not authenticated");
});

Deno.test("aead: empty plaintext and empty aad still authenticate", () => {
  const empty = new Uint8Array(0);
  const ct = enc(KEY, NONCE, empty);
  if (ct.length !== 0) throw new Error("empty plaintext produced ciphertext");
  const t = tag(KEY, NONCE, empty, ct);
  if (hex(dec(KEY, NONCE, empty, ct, t)) !== "") throw new Error("empty round trip failed");
  if (!rejects(() => dec(KEY, NONCE, new Uint8Array([1]), ct, t))) throw new Error("accepted added aad");
});
