// Branch coverage for crypto.
//
// The exercises here mirror the *shapes* the test suite drives — the same lengths,
// key sizes, IV sizes and rejection cases — but with filler bytes rather than the
// published vectors, because which branch runs depends on those shapes and not on the
// values. That keeps this file short without letting it drift into measuring a
// workload the tests never run, which would report on this file rather than on what
// is actually checked.
//
// The reverse direction is the one that needs care: every input below has a matching
// test. When a branch here has no assertion behind it, the honest fix is a test, not
// another call in this file — reaching a guard proves only that it was reached, and a
// guard that accepts what it should reject is reached just as thoroughly.
//
//   deno task coverage:crypto
//   deno task coverage:crypto --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");

const run = await instrument("packages/crypto/test/wac/probe.wac");
const f = <T extends (...a: never[]) => unknown>(name: string) => run.mod[name] as T;

const sha256 = f<(b: Uint8Array) => Uint8Array>("sha256");
const sha512 = f<(b: Uint8Array) => Uint8Array>("sha512");
const sha384 = f<(b: Uint8Array) => Uint8Array>("sha384");
const hmac = f<(k: Uint8Array, m: Uint8Array) => Uint8Array>("hmac");
const hkdf = f<(s: Uint8Array, i: Uint8Array, n: Uint8Array, l: number) => Uint8Array>("hkdf");
const hkdfExtract = f<(s: Uint8Array, i: Uint8Array) => Uint8Array>("hkdfExtract");
const chachaBlock = f<(k: Uint8Array, c: number, n: Uint8Array) => Uint8Array>("chachaBlock");
const chacha20 = f<(k: Uint8Array, c: number, n: Uint8Array, m: Uint8Array) => Uint8Array>("chacha20");
const poly1305 = f<(k: Uint8Array, m: Uint8Array) => Uint8Array>("poly1305");
const aeadEncrypt = f<(k: Uint8Array, n: Uint8Array, p: Uint8Array) => Uint8Array>("aeadEncrypt");
const aeadTag = f<(k: Uint8Array, n: Uint8Array, a: Uint8Array, c: Uint8Array) => Uint8Array>("aeadTag");
const aeadDecrypt =
  f<(k: Uint8Array, n: Uint8Array, a: Uint8Array, c: Uint8Array, t: Uint8Array) => Uint8Array>("aeadDecrypt");
const aesEncrypt = f<(k: Uint8Array, b: Uint8Array) => Uint8Array>("aesEncrypt");
const aesDecrypt = f<(k: Uint8Array, b: Uint8Array) => Uint8Array>("aesDecrypt");
const aesCtr = f<(k: Uint8Array, iv: Uint8Array, d: Uint8Array) => Uint8Array>("aesCtr");
const ghash = f<(h: Uint8Array, d: Uint8Array) => Uint8Array>("ghash");
const gcmEncrypt = f<(k: Uint8Array, iv: Uint8Array, p: Uint8Array) => Uint8Array>("gcmEncrypt");
const gcmTag = f<(k: Uint8Array, iv: Uint8Array, a: Uint8Array, c: Uint8Array) => Uint8Array>("gcmTag");
const gcmDecrypt =
  f<(k: Uint8Array, iv: Uint8Array, a: Uint8Array, c: Uint8Array, t: Uint8Array) => Uint8Array>("gcmDecrypt");
const gcmInc32 = f<(c: Uint8Array) => Uint8Array>("gcmInc32");
const leWord32 = f<(b: Uint8Array, i: number) => number>("leWord32");
const beWord32 = f<(b: Uint8Array, i: number) => number>("beWord32");
const beWord64 = f<(b: Uint8Array, i: number) => bigint>("beWord64");
const storeLE32 = f<(v: number) => Uint8Array>("storeLE32");
const storeBE32 = f<(v: number) => Uint8Array>("storeBE32");
const storeBE64 = f<(v: bigint) => Uint8Array>("storeBE64");
const padTo16 = f<(n: number) => number>("padTo16");

/**
 * Run a call that must trap, and fail loudly if it does not.
 *
 * `aeadDecrypt` and `gcmDecrypt` reject a bad tag by trapping, so reaching their
 * rejection branch means catching. Catching *silently* would turn "the forgery was
 * accepted" into a coverage run that passes, so the absence of a trap is an error here
 * even though this file's job is only to measure.
 */
function mustTrap(what: string, call: () => unknown): void {
  try {
    call();
  } catch {
    return;
  }
  throw new Error(`${what} was expected to trap and did not`);
}

/** Deterministic filler; `seed` varies the contents so repeats are not identical. */
const bytes = (n: number, seed = 0) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 17 + 7) & 0xFF);

/**
 * Lengths that straddle every block and padding boundary in the package: the empty
 * input, one short of a block, exactly a block, one over, and a multi-block message.
 * SHA-256 pads at 64 with a 9-byte tail, SHA-512 at 128 with a 17-byte tail, so the
 * two need different sets — 55/56 is the interesting pair for one and 111/112 for the
 * other.
 */
const SHA256_LENS = [0, 1, 55, 56, 63, 64, 65, 119, 120, 200];
const SHA512_LENS = [0, 1, 111, 112, 127, 128, 129, 239, 240, 400];

for (const n of SHA256_LENS) sha256(bytes(n));
for (const n of SHA512_LENS) {
  sha512(bytes(n));
  sha384(bytes(n));
}

/** HMAC's three key regimes: shorter than the block, exactly it, and hashed down. */
for (const keyLen of [0, 1, 32, 63, 64, 65, 200]) {
  for (const msgLen of [0, 1, 64, 150]) hmac(bytes(keyLen, 1), bytes(msgLen, 2));
}

/** HKDF: the zero-salt default, and output lengths either side of a hash block. */
hkdfExtract(new Uint8Array(0), bytes(22, 3));
for (const len of [1, 31, 32, 33, 42, 64, 82, 255 * 32]) {
  hkdf(bytes(13, 4), bytes(22, 5), bytes(10, 6), len);
}
hkdf(new Uint8Array(0), bytes(22, 7), new Uint8Array(0), 42);
// RFC 5869 caps output at 255 hash lengths, because the counter is one byte. Both
// sides of that boundary: 255*32 is the largest legal request, one more traps.
hkdf(bytes(13, 4), bytes(22, 5), bytes(10, 6), 255 * 32);
mustTrap("hkdf over the 255-block cap", () =>
  hkdf(bytes(13, 4), bytes(22, 5), bytes(10, 6), 255 * 32 + 1));

/** ChaCha20: the counter's low word, and messages that do and do not fill a block. */
for (const ctr of [0, 1, 0xFFFFFFFF]) chachaBlock(bytes(32, 8), ctr, bytes(12, 9));
for (const n of [0, 1, 63, 64, 65, 127, 128, 375]) chacha20(bytes(32, 10), 1, bytes(12, 11), bytes(n));

/** Poly1305: the partial-final-block path, and the r-clamping in the key. */
for (const n of [0, 1, 15, 16, 17, 32, 33, 64, 129]) poly1305(bytes(32, 12), bytes(n, 13));

/** ChaCha20-Poly1305: AAD and ciphertext each padded to 16 independently. */
for (const aadLen of [0, 1, 15, 16, 17, 20]) {
  for (const ptLen of [0, 1, 15, 16, 17, 114]) {
    const ct = aeadEncrypt(bytes(32, 14), bytes(12, 15), bytes(ptLen, 16));
    const tag = aeadTag(bytes(32, 14), bytes(12, 15), bytes(aadLen, 17), ct);
    aeadDecrypt(bytes(32, 14), bytes(12, 15), bytes(aadLen, 17), ct, tag);
    // The rejection path: a tag that differs in its last byte must not verify.
    const bad = Uint8Array.from(tag);
    bad[15] ^= 1;
    mustTrap(`aeadDecrypt aad=${aadLen} pt=${ptLen}`, () =>
      aeadDecrypt(bytes(32, 14), bytes(12, 15), bytes(aadLen, 17), ct, bad));
    // A tag of the wrong length is rejected before any comparison.
    mustTrap("aeadDecrypt short tag", () =>
      aeadDecrypt(bytes(32, 14), bytes(12, 15), bytes(aadLen, 17), ct, tag.subarray(0, 15)));
  }
}

/** AES: all three key sizes, both directions, since the round count differs. */
for (const keyLen of [16, 24, 32]) {
  aesEncrypt(bytes(keyLen, 18), bytes(16, 19));
  aesDecrypt(bytes(keyLen, 18), bytes(16, 19));
  for (const n of [0, 1, 15, 16, 17, 64, 100]) aesCtr(bytes(keyLen, 18), bytes(16, 20), bytes(n, 21));
}
mustTrap("aesEncrypt with a 20-byte key", () => aesEncrypt(bytes(20, 18), bytes(16, 19)));
mustTrap("aesCtr with a 15-byte IV", () => aesCtr(bytes(16, 18), bytes(15, 20), bytes(32, 21)));

/**
 * GHASH: whole blocks only — it rejects anything else rather than zero-filling, so a
 * partial length belongs in the rejection set below, not here. All-ones drives the
 * reduction branch on nearly every one of the 128 iterations.
 */
for (const n of [0, 16, 32, 48, 160]) ghash(bytes(16, 22), bytes(n, 23));
ghash(new Uint8Array(16).fill(0xFF), new Uint8Array(32).fill(0xFF));

/** Its two preconditions, each of which is a branch. */
mustTrap("ghash partial block", () => ghash(bytes(16, 22), bytes(17, 23)));
mustTrap("ghash short h", () => ghash(bytes(15, 22), bytes(16, 23)));

/** AES-GCM: the 96-bit IV shortcut and the GHASH-the-IV path for every other length. */
for (const ivLen of [8, 12, 16, 60]) {
  for (const aadLen of [0, 16, 20]) {
    for (const ptLen of [0, 1, 15, 16, 60]) {
      const ct = gcmEncrypt(bytes(16, 24), bytes(ivLen, 25), bytes(ptLen, 26));
      const tag = gcmTag(bytes(16, 24), bytes(ivLen, 25), bytes(aadLen, 27), ct);
      gcmDecrypt(bytes(16, 24), bytes(ivLen, 25), bytes(aadLen, 27), ct, tag);
      const bad = Uint8Array.from(tag);
      bad[0] ^= 0x80;
      mustTrap(`gcmDecrypt iv=${ivLen} aad=${aadLen} ct=${ptLen}`, () =>
        gcmDecrypt(bytes(16, 24), bytes(ivLen, 25), bytes(aadLen, 27), ct, bad));
    }
  }
}

/** The counter increment's wrap: all-ones in the low word must carry into nothing. */
// Both empty-IV guards; gcmEncrypt's and gcmTag's are separate checks on separate
// exports, so one does not stand in for the other.
mustTrap("gcmEncrypt empty IV", () => gcmEncrypt(bytes(16, 24), new Uint8Array(0), bytes(16, 26)));
mustTrap("gcmTag empty IV", () => gcmTag(bytes(16, 24), new Uint8Array(0), bytes(16, 27), bytes(16, 26)));
mustTrap("gcmDecrypt short tag", () =>
  gcmDecrypt(bytes(16, 24), bytes(12, 25), bytes(16, 27), bytes(16, 26), bytes(15, 28)));

gcmInc32(new Uint8Array(16));
gcmInc32(Uint8Array.from({ length: 16 }, (_, i) => (i >= 12 ? 0xFF : 0)));

/**
 * layout.wac's conversions directly. Every primitive above already drives them, but
 * `padTo16`'s aligned and unaligned arms are the kind of two-branch helper where the
 * callers happen to cover both — driving it explicitly keeps that from being luck.
 */
for (let off = 0; off < 8; off++) {
  leWord32(bytes(16, 29), off);
  beWord32(bytes(16, 29), off);
  beWord64(bytes(16, 29), off);
}
for (const v of [0, 1, 0x80000000, 0xFFFFFFFF]) {
  storeLE32(v);
  storeBE32(v);
}
for (const v of [0n, 1n, 0x8000000000000000n, 0xFFFFFFFFFFFFFFFFn]) storeBE64(v);
for (let n = 0; n <= 32; n++) padTo16(n);

const { total, covered } = report([run], "packages/crypto/", { verbose });
if (covered < total) Deno.exit(1);
