// Registers the wac-side SHA-2 tests and hands them their oracle.
//
// Everything this file does is supply a fact from outside the sandbox. The loop, the
// boundary lengths, the assertions and the failure messages all live in
// `test/wac/hash_test.wac`, which is the point of the exercise: the only thing that needs
// TypeScript is the independent implementation, so that is the only thing here.
//
// `node:crypto` rather than WebCrypto, and not by preference. `crypto.subtle.digest`
// returns a Promise and a wasm call cannot await it, so it cannot be a callback; node's
// `createHash` is synchronous and can. Both are OpenSSL underneath in Deno, so the
// oracle is no weaker for it.

import { createHash } from "node:crypto";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

/** SHA-2 at the requested digest size, synchronously. */
function hash(bytes: Uint8Array, bits: number): Uint8Array {
  const algo = bits === 256 ? "sha256" : bits === 384 ? "sha384" : "sha512";
  return new Uint8Array(createHash(algo).update(bytes).digest());
}

await wacTestRun("packages/crypto/test/wac/hash_test.wac", "hash", [hash]);
