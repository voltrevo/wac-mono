// Registers the wac-side record layer tests and supplies an AEAD.
//
// The oracle is the primitive, not a TLS stack: `node:crypto`'s AES-128-GCM and
// ChaCha20-Poly1305, both synchronous. What the record layer builds on top — the nonce
// from the sequence number, the header as additional data, the type byte hidden inside
// the plaintext — is the part worth checking against something that shares none of our
// assumptions, and an implementation that also knew TLS would share all of them.
import { createDecipheriv } from "node:crypto";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const AES = 0x1301;

/** Decrypt, or an empty array if the tag does not verify. */
function aead(
  suite: number, key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ct: Uint8Array,
): Uint8Array {
  const algo = suite === AES ? "aes-128-gcm" : "chacha20-poly1305";
  const body = ct.subarray(0, ct.length - 16);
  const tag = ct.subarray(ct.length - 16);
  try {
    const d = createDecipheriv(algo, key, nonce, { authTagLength: 16 });
    d.setAAD(aad, { plaintextLength: body.length });
    d.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([d.update(body), d.final()]));
  } catch {
    return new Uint8Array(0);   // a failed tag is an answer, not an error
  }
}

import { Buffer } from "node:buffer";
await wacTestRun("packages/tls/test/wac/record_test.wac", "record", [aead]);
