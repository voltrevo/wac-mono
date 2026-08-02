// The record layer's refusals.
//
// Only the refusals. The round trips, the sequence number in the nonce, the header as
// additional data, the inner content type, padding, and the alert registry all moved to
// `test/wac/record_test.wac`, where the oracle is `node:crypto`'s AEAD passed in as a
// callback rather than a whole TLS implementation.
//
// These stayed because they trap, and a trap unwinds the module rather than returning, so
// wac cannot assert one. That is most of what a record layer owes its caller: a peer
// controls every byte of a record it is handed, so "this must be refused" is the half
// that matters.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/tls/test/wac/probe.wac");
const seal = mod.tlsSeal as (
  suite: number, k: Uint8Array, iv: Uint8Array, seq: bigint, ct: number, content: Uint8Array, pad: number,
) => Uint8Array;
const open = mod.tlsOpen as (
  suite: number, k: Uint8Array, iv: Uint8Array, seq: bigint, rec: Uint8Array,
) => Uint8Array;
const recordType = mod.tlsRecordType as (inner: Uint8Array) => number;
const recordContent = mod.tlsRecordContent as (inner: Uint8Array) => Uint8Array;
const recordLength = mod.tlsRecordLength as (buf: Uint8Array) => number;
const AES = (mod.tlsSuiteAes as () => number)();
const CHACHA = (mod.tlsSuiteChaCha as () => number)();
const suiteKeyLen = mod.tlsSuiteKeyLen as (s: number) => number;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const bytes = (n: number, seed = 0) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 17 + 7) & 0xFF);
const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

const HANDSHAKE = 22, APPLICATION = 23, ALERT = 21;

/** The nonce RFC 8446 §5.3 specifies, computed here rather than taken from the code. */
function refNonce(iv: Uint8Array, seq: bigint): Uint8Array {
  const n = Uint8Array.from(iv);
  for (let i = 0; i < 8; i++) {
    n[4 + i] ^= Number((seq >> BigInt((7 - i) * 8)) & 0xFFn);
  }
  return n;
}

Deno.test("record: rejects tampering in the ciphertext and the tag", () => {
  const key = bytes(16, 13);
  const iv = bytes(12, 14);
  const record = seal(AES, key, iv, 5n, APPLICATION, bytes(64, 15), 2);
  for (const i of [5, 20, record.length - 17, record.length - 16, record.length - 1]) {
    const bad = Uint8Array.from(record);
    bad[i] ^= 0x80;
    if (!traps(() => open(AES, key, iv, 5n, bad))) throw new Error(`byte ${i} was not authenticated`);
  }
  // A different key must not open it either.
  if (!traps(() => open(AES, bytes(16, 99), iv, 5n, record))) throw new Error("the wrong key opened a record");
});

Deno.test("record: rejects malformed framing before attempting to decrypt", () => {
  const key = bytes(16, 22);
  const iv = bytes(12, 23);
  const record = seal(AES, key, iv, 0n, APPLICATION, bytes(40, 24), 0);
  // Too short to hold a header and a tag.
  for (const n of [0, 4, 5, 20]) {
    if (!traps(() => open(AES, key, iv, 0n, record.subarray(0, n)))) throw new Error(`accepted a ${n}-byte record`);
  }
  // A length field that disagrees with the buffer.
  const wrongLen = Uint8Array.from(record);
  wrongLen[4] = (wrongLen[4] + 1) & 0xFF;
  if (!traps(() => open(AES, key, iv, 0n, wrongLen))) throw new Error("accepted a length that did not match");
  // And an oversized claim, which is how a peer asks for an allocation.
  const huge = Uint8Array.from(record);
  huge[3] = 0xFF;
  huge[4] = 0xFF;
  if (!traps(() => open(AES, key, iv, 0n, huge))) throw new Error("accepted an oversized length");

  if (recordLength(record) !== record.length - 5) throw new Error("recordLength disagreed with the record");
  if (recordLength(new Uint8Array(4)) !== -1) throw new Error("recordLength should say -1 below five bytes");
});

Deno.test("record: refuses plaintext beyond the 16384-byte limit", () => {
  const key = bytes(16, 25);
  const iv = bytes(12, 26);
  seal(AES, key, iv, 0n, APPLICATION, bytes(16384, 27), 0);
  if (!traps(() => seal(AES, key, iv, 0n, APPLICATION, bytes(16385, 27), 0))) {
    throw new Error("sealed a record over the plaintext limit");
  }
  if (!traps(() => seal(999, key, iv, 0n, APPLICATION, bytes(10, 27), 0))) {
    throw new Error("sealed under an unknown cipher suite");
  }
});
