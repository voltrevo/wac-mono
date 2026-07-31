// ChaCha20 against RFC 8439's worked examples.
//
// WebCrypto has no ChaCha20, so unlike SHA-256 and HMAC there is no host oracle
// here — the RFC's vectors are the whole check, plus the structural properties
// (xor is an involution, the counter advances per block) that catch mistakes
// the vectors would not.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);
const block = mod.chachaBlock as (k: Uint8Array, c: number, n: Uint8Array) => Uint8Array;
const chacha20 = mod.chacha20 as (k: Uint8Array, c: number, n: Uint8Array, m: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.replace(/\s/g, "").match(/../g)!.map(h => parseInt(h, 16)));

const KEY = unhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");

Deno.test("chacha20: RFC 8439 §2.3.2 block function", () => {
  const nonce = unhex("000000090000004a00000000");
  const got = hex(block(KEY, 1, nonce));
  const want =
    "10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e" +
    "d2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e";
  if (got !== want) throw new Error(`block:\n  got  ${got}\n  want ${want}`);
});

Deno.test("chacha20: RFC 8439 §2.4.2 encryption", () => {
  const nonce = unhex("000000000000004a00000000");
  const plain = new TextEncoder().encode(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const got = hex(chacha20(KEY, 1, nonce, plain));
  const want =
    "6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b" +
    "f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8" +
    "07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab7793736" +
    "5af90bbf74a35be6b40b8eedf2785e42874d";
  if (got !== want) throw new Error(`encrypt:\n  got  ${got}\n  want ${want}`);
});

Deno.test("chacha20: RFC 8439 A.2 — counter 0, and a second key", () => {
  const zeros = new Uint8Array(32);
  const nonce0 = new Uint8Array(12);
  const got = hex(chacha20(zeros, 0, nonce0, new Uint8Array(64)));
  const want =
    "76b8e0ada0f13d90405d6ae55386bd28bdd219b8a08ded1aa836efcc8b770dc7" +
    "da41597c5157488d7724e03fb8d84a376a43b8f41518a11cc387b669b2ee6586";
  if (got !== want) throw new Error(`A.2 case 1:\n  got  ${got}\n  want ${want}`);
});

Deno.test("chacha20: decryption is encryption, and blocks chain", () => {
  const nonce = unhex("000000000000004a00000000");
  // Not a multiple of 64, so the final partial block is exercised.
  const msg = new Uint8Array(197);
  for (let i = 0; i < msg.length; i++) msg[i] = (i * 31 + 7) & 0xFF;

  const ct = chacha20(KEY, 1, nonce, msg);
  const back = chacha20(KEY, 1, nonce, ct);
  if (hex(back) !== hex(msg)) throw new Error("round trip failed");
  if (hex(ct) === hex(msg)) throw new Error("ciphertext equals plaintext");

  // Each 64-byte slice must equal that block's keystream xor the plaintext, so
  // an off-by-one in the counter shows up here rather than silently.
  for (let b = 0; b * 64 < msg.length; b++) {
    const ks = block(KEY, 1 + b, nonce);
    for (let j = 0; j < 64 && b * 64 + j < msg.length; j++) {
      const i = b * 64 + j;
      if (ct[i] !== (msg[i] ^ ks[j])) throw new Error(`block ${b} byte ${j} mismatch`);
    }
  }
});
