// The TLS 1.3 record layer.
//
// A round trip proves almost nothing here: seal and open share every constant, so a
// nonce built the wrong way, an AAD covering the wrong bytes, or a content type read
// from the wrong end would all round-trip perfectly and interoperate with nothing. The
// checks that matter are the ones an outside implementation can disagree with.
//
// WebCrypto is that outside implementation for AES-128-GCM: it decrypts what we seal,
// given the nonce and additional data computed independently here. If our nonce
// construction, our AAD, or our ciphertext framing were wrong in any way, it would fail
// — which is a much stronger statement than our own opener accepting our own sealer.

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

Deno.test("record: WebCrypto decrypts what we seal, for every shape", async () => {
  const key = bytes(16, 1);
  const iv = bytes(12, 2);
  for (const len of [0, 1, 15, 16, 17, 64, 1000]) {
    for (const pad of [0, 1, 7]) {
      for (const seq of [0n, 1n, 255n, 256n, 0xFFFFFFFFn, 0x1_0000_0000n]) {
        const content = bytes(len, 3);
        const record = seal(AES, key, iv, seq, HANDSHAKE, content, pad);

        // Everything below is derived from the spec, not from the record.
        const sealedLen = record.length - 5;
        const aad = Uint8Array.from([23, 3, 3, (sealedLen >> 8) & 0xFF, sealedLen & 0xFF]);
        if (hex(record.subarray(0, 5)) !== hex(aad)) {
          throw new Error(`header\n  got  ${hex(record.subarray(0, 5))}\n  want ${hex(aad)}`);
        }
        const ck = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["decrypt"]);
        const plain = new Uint8Array(await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: refNonce(iv, seq) as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
          ck, record.subarray(5) as BufferSource));

        // The inner plaintext is content ++ type ++ padding.
        const want = new Uint8Array(len + 1 + pad);
        want.set(content);
        want[len] = HANDSHAKE;
        if (hex(plain) !== hex(want)) {
          throw new Error(`len=${len} pad=${pad} seq=${seq}\n  got  ${hex(plain)}\n  want ${hex(want)}`);
        }
      }
    }
  }
});

Deno.test("record: round-trips both suites, every content type and length", () => {
  for (const suite of [AES, CHACHA]) {
    const key = bytes(suiteKeyLen(suite), 4);
    const iv = bytes(12, 5);
    for (const type of [HANDSHAKE, APPLICATION, ALERT, 20]) {
      for (const len of [0, 1, 100, 16384]) {
        const content = bytes(len, 6);
        const record = seal(suite, key, iv, 42n, type, content, 3);
        const inner = open(suite, key, iv, 42n, record);
        if (recordType(inner) !== type) throw new Error(`type: got ${recordType(inner)}, want ${type}`);
        if (hex(recordContent(inner)) !== hex(content)) throw new Error(`content at len ${len}`);
      }
    }
  }
});

Deno.test("record: the sequence number is part of the nonce, so records are not fungible", () => {
  // The most valuable property in the file. Nothing on the wire identifies which record
  // this is, so the counter is the only thing binding a ciphertext to its position — and
  // a nonce that ignored the sequence number would round-trip, would let WebCrypto
  // decrypt it, and would let an attacker replay or reorder records freely.
  const key = bytes(16, 7);
  const iv = bytes(12, 8);
  const content = bytes(50, 9);
  const first = seal(AES, key, iv, 0n, APPLICATION, content, 0);
  const second = seal(AES, key, iv, 1n, APPLICATION, content, 0);
  if (hex(first) === hex(second)) throw new Error("the same content sealed identically at two sequence numbers");
  if (!traps(() => open(AES, key, iv, 1n, first))) throw new Error("a record opened at the wrong sequence number");
  if (!traps(() => open(AES, key, iv, 0n, second))) throw new Error("a record opened at the wrong sequence number");

  // The counter is right-aligned in the IV, so incrementing it must not disturb the
  // first four bytes. Left-aligning would still work for sequence number zero.
  const big = seal(AES, key, iv, 0xFFFF_FFFF_FFFF_FFFFn, APPLICATION, content, 0);
  open(AES, key, iv, 0xFFFF_FFFF_FFFF_FFFFn, big);
});

Deno.test("record: the header is authenticated, so its length cannot be rewritten", () => {
  const key = bytes(16, 10);
  const iv = bytes(12, 11);
  const record = seal(AES, key, iv, 0n, HANDSHAKE, bytes(80, 12), 0);
  for (const i of [0, 1, 2, 3, 4]) {
    const bad = Uint8Array.from(record);
    bad[i] ^= 1;
    // Bytes 3 and 4 are the length: flipping them makes the framing check fail as well
    // as the tag, and either rejection is correct. What must not happen is acceptance.
    if (!traps(() => open(AES, key, iv, 0n, bad))) throw new Error(`header byte ${i} was not authenticated`);
  }
});

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

Deno.test("record: the content type comes from inside, not from the header", () => {
  // Every TLS 1.3 record says application_data on the wire. A reader that believed the
  // outer byte would route handshake messages as application data — and would still
  // pass a round-trip test, because the sealer writes 23 there too.
  const key = bytes(16, 16);
  const iv = bytes(12, 17);
  for (const type of [HANDSHAKE, ALERT, 20]) {
    const record = seal(AES, key, iv, 0n, type, bytes(10, 18), 0);
    if (record[0] !== 23) throw new Error(`outer type was ${record[0]}, should always be 23`);
    if (recordType(open(AES, key, iv, 0n, record)) !== type) throw new Error(`inner type lost for ${type}`);
  }
});

Deno.test("record: padding is invisible to the reader but changes the wire length", () => {
  const key = bytes(16, 19);
  const iv = bytes(12, 20);
  const content = bytes(30, 21);
  const none = seal(AES, key, iv, 0n, APPLICATION, content, 0);
  const padded = seal(AES, key, iv, 0n, APPLICATION, content, 100);
  if (padded.length !== none.length + 100) throw new Error("padding did not change the record length");
  if (hex(recordContent(open(AES, key, iv, 0n, padded))) !== hex(content)) {
    throw new Error("padding leaked into the content");
  }
  // A record that is nothing but padding has no content type and is malformed.
  const allZero = new Uint8Array(8);
  if (!traps(() => recordType(allZero))) throw new Error("an all-padding record reported a type");
  if (!traps(() => recordContent(allZero))) throw new Error("an all-padding record yielded content");
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
