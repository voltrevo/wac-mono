// Registers the wac-side Poly1305 and ChaCha20-Poly1305 tests.
//
// The oracle is a whole AEAD this time rather than a primitive, and deliberately: what
// RFC 8439 §2.8 adds on top of its two parts is the framing — each field padded to
// sixteen bytes, then both lengths as 64-bit little-endian counts — and framing is exactly
// what an independent implementation of the *same* construction disagrees with you about
// when you get it wrong.
import { createDecipheriv } from "node:crypto";
import { Buffer } from "node:buffer";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

/** Decrypt ciphertext-with-tag, or an empty array if the tag does not verify. */
function open(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ctTag: Uint8Array): Uint8Array {
  const body = ctTag.subarray(0, ctTag.length - 16);
  const tag = ctTag.subarray(ctTag.length - 16);
  try {
    const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    d.setAAD(aad, { plaintextLength: body.length });
    d.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([d.update(body), d.final()]));
  } catch {
    return new Uint8Array(0);
  }
}

await wacTestRun("packages/crypto/test/wac/aead_test.wac", "aead", [open]);
