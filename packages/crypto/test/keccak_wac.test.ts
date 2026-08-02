// Registers the wac-side Keccak tests and supplies SHA-3 and SHAKE.
//
// node:crypto rather than an OpenSSL subprocess, which is what this replaces. WebCrypto
// has SHA3 but no SHAKE, so the extendable-output tests used to shell out to an OpenSSL
// 3.5 built from source and mark themselves `ignore` when it was missing — green, and
// checking nothing. node has shake128 and shake256 built in and synchronously.
import { createHash } from "node:crypto";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const ALGOS = ["sha3-256", "sha3-512", "shake128", "shake256"];

/** `hash(algo, message, outLen)` — outLen is honoured for the two extendable ones. */
function hash(algo: number, msg: Uint8Array, outLen: number): Uint8Array {
  const name = ALGOS[algo];
  const h = algo >= 2
    ? createHash(name, { outputLength: outLen } as unknown as undefined)
    : createHash(name);
  return new Uint8Array(h.update(msg).digest());
}

await wacTestRun("packages/crypto/test/wac/keccak_test.wac", "keccak", [hash]);
