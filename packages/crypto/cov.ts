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
// Curve25519 has its own probe: the field operations are internal to the package and
// reach the boundary only for the BigInt differential.
const curve = await instrument("packages/crypto/test/wac/curve25519_probe.wac");
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

/**
 * Curve25519, at the shapes its tests drive.
 *
 * The ladder covers nearly everything on its own — 255 rounds of every field operation —
 * so what is listed separately here is the parts a ladder never reaches: the encoder's
 * conditional final subtraction, which needs a value at or above p, and both arms of the
 * conditional swap.
 */
{
  const c = <T extends (...a: never[]) => unknown>(name: string) => curve.mod[name] as T;
  const x25519 = c<(k: Uint8Array, u: Uint8Array) => Uint8Array>("x25519");
  const x25519Base = c<(k: Uint8Array) => Uint8Array>("x25519Base");
  const fAdd = c<(a: Uint8Array, b: Uint8Array) => Uint8Array>("fAdd");
  const fSub = c<(a: Uint8Array, b: Uint8Array) => Uint8Array>("fSub");
  const fMul = c<(a: Uint8Array, b: Uint8Array) => Uint8Array>("fMul");
  const fSquare = c<(a: Uint8Array) => Uint8Array>("fSquare");
  const fMulSmall = c<(a: Uint8Array, m: bigint) => Uint8Array>("fMulSmall");
  const fInvert = c<(a: Uint8Array) => Uint8Array>("fInvert");
  const fRoundTrip = c<(a: Uint8Array) => Uint8Array>("fRoundTrip");
  const fCSwap = c<(a: Uint8Array, b: Uint8Array, s: number) => Uint8Array>("fCSwap");

  const P = (1n << 255n) - 19n;
  const enc = (v: bigint) => {
    const o = new Uint8Array(32);
    let x = ((v % P) + P) % P;
    for (let i = 0; i < 32; i++) { o[i] = Number(x & 0xFFn); x >>= 8n; }
    return o;
  };
  // Values at and just below p, so feToBytes takes both sides of its final subtraction.
  for (const v of [0n, 1n, P - 1n, P - 2n, (1n << 254n), (1n << 26n), (1n << 25n)]) {
    fRoundTrip(enc(v));
    fInvert(enc(v));
    fSquare(enc(v));
    fMulSmall(enc(v), 121665n);
    fAdd(enc(v), enc(P - 1n));
    fSub(enc(v), enc(P - 1n));
    fMul(enc(v), enc(P - 2n));
  }
  // A u-coordinate with bit 255 set: ignored, and ignored structurally rather than by a
  // branch — see the note on feFromBytes.
  const masked = enc(1n);
  masked[31] |= 0x80;
  fRoundTrip(masked);
  // A sum that lands on exactly p. Every canonical input is already below p, so nothing
  // above reaches feToBytes' final conditional subtraction; this is the only way to.
  fAdd(enc(P - 19n), enc(19n));
  fAdd(enc(P - 1n), enc(1n));
  fCSwap(enc(3n), enc(5n), 0);
  fCSwap(enc(3n), enc(5n), 1);

  // Ed25519. Signing and verifying between them reach the group law, both branches of
  // the scalar select, encoding and decoding; the rejection cases reach the rest.
  const edPublicKey = c<(s: Uint8Array) => Uint8Array>("edPublicKey");
  const edSign = c<(s: Uint8Array, m: Uint8Array) => Uint8Array>("edSign");
  const edVerify = c<(p: Uint8Array, m: Uint8Array, s: Uint8Array) => boolean>("edVerify");
  const edRecode = c<(p: Uint8Array) => Uint8Array>("edRecode");
  const edScalarBase = c<(k: Uint8Array) => Uint8Array>("edScalarBase");
  c<() => Uint8Array>("edBaseEncoded")();

  const seed = bytes(32, 50);
  const pub = edPublicKey(seed);
  for (const msgLen of [0, 1, 64]) {
    const msg = bytes(msgLen, 51);
    const sig = edSign(seed, msg);
    edVerify(pub, msg, sig);
    const tampered = Uint8Array.from(sig);
    tampered[0] ^= 1;
    edVerify(pub, msg, tampered);         // R decodes but the equation fails
  }
  // Rejections: bad lengths, an S at or above L, a y that is not on the curve.
  edVerify(bytes(31, 52), bytes(4, 53), bytes(64, 54));
  edVerify(pub, bytes(4, 53), bytes(63, 54));
  edVerify(pub, bytes(4, 53), bytes(64, 55));   // random S is almost surely >= L or a bad point
  const notAPoint = new Uint8Array(32);
  notAPoint[0] = 2;
  edRecode(notAPoint);
  edRecode(pub);
  // An odd-x point, so the sign branch in recoverX runs both ways.
  const oddX = Uint8Array.from(pub);
  oddX[31] ^= 0x80;
  edRecode(oddX);
  edScalarBase(bytes(32, 56));
  // y = 1 with the sign bit set: x is zero, which has no odd root, so the decode must
  // fail. This is the one branch in recoverX that a valid point never reaches.
  const yOneOddX = new Uint8Array(32);
  yOneOddX[0] = 1;
  yOneOddX[31] = 0x80;
  edRecode(yOneOddX);
  edRecode(bytes(31, 57));                      // wrong length
  mustTrap("edPublicKey short seed", () => edPublicKey(bytes(31, 58)));
  mustTrap("edSign short seed", () => edSign(bytes(31, 58), bytes(4, 59)));
  // A public key that is not a point, and a signature whose R is not a point.
  const goodSig = edSign(seed, bytes(8, 60));
  edVerify(notAPoint, bytes(8, 60), goodSig);
  const badR = Uint8Array.from(goodSig);
  badR.set(notAPoint, 0);
  edVerify(pub, bytes(8, 60), badR);

  x25519Base(bytes(32, 40));
  x25519(bytes(32, 41), x25519Base(bytes(32, 42)));
  mustTrap("x25519 short scalar", () => x25519(bytes(31, 43), bytes(32, 44)));
  mustTrap("x25519 short u", () => x25519(bytes(32, 43), bytes(31, 44)));
}

/**
 * Branch points no exercise here reaches, with the reason.
 *
 * Named rather than tolerated as a percentage below 100, for the same reason gzip's
 * cov.ts carries a list: a report that sits at 99.3% forever teaches everyone to skip
 * the last line, and then a real gap arrives looking like the one that was always there.
 */
const UNREACHED: { file: string; line: number; snippet: string; why: string }[] = [
  {
    file: "packages/crypto/src/field25519.wac",
    line: 200,
    snippet: "if (geP == 1)",
    why:
      "feToBytes' final conditional subtraction, for a value that is still in [p, 2^255) " +
      "after carrying. No input reaches it, and the likely reason is that feCarry's " +
      "round-to-nearest pass already folds anything at or above about 2^254 back down, so " +
      "the nineteen values in that band never survive to be tested. That is an argument, " +
      "not a proof — I could not construct an input, and I have not shown none exists. " +
      "It stays because the cost of being wrong in the other direction is a " +
      "non-canonical encoding for those nineteen values, which is the kind of defect " +
      "that shows up as an interop failure years later. If someone proves it dead, " +
      "delete it and this entry together.",
  },
  {
    file: "packages/crypto/src/field25519.wac",
    line: 202,
    snippet: "for (i32 i = 0; i < 10; i++) { h[i] = t[i]; }",
    why: "The copy inside that same conditional. Unreached for the one reason above, not " +
      "a second one.",
  },
  {
    file: "packages/crypto/src/rsa.wac",
    line: 54,
    snippet: "if (!isZero(cur)) { trap; }",
    why: "toBytes' overflow guard. Every caller passes a length taken from the modulus " +
      "and a value already reduced below it, so the value always fits. Defensive against " +
      "a future caller that computes the length some other way.",
  },
  {
    file: "packages/crypto/src/rsa.wac",
    line: 67,
    snippet: "if (limb >= a.n) { return 0; }",
    why: "bitAt reading past the top limb. modPow bounds its loop by bitLen(exp), so it " +
      "never asks for a bit above the exponent's own length. Kept because a bit accessor " +
      "that reads out of range on a plausible argument is a worse thing to leave than an " +
      "unreached branch.",
  },
  {
    file: "packages/crypto/src/rsa.wac",
    line: 234,
    snippet: "if (diff != 0) { return false; }",
    why: "PSS's check that the unmasked DB is zeros then 0x01. Reaching it needs a " +
      "signature whose masked DB unmasks to the wrong shape *and* whose trailer and " +
      "unused bits are both right — an attacker constructing one, not a bit flip, which " +
      "changes the mask and fails earlier. The check is the reason that attack does not " +
      "work, so it stays untested rather than removed.",
  },
  {
    file: "packages/crypto/src/fieldp256.wac",
    line: 273,
    snippet: "if (s.len() != 32) { trap; }",
    why: "fpFromBytes' length guard. Every caller inside the package passes exactly 32, " +
      "and the function is not on the package's public surface, so nothing can reach it " +
      "without a code change. Defensive against a future caller.",
  },
  {
    file: "packages/crypto/src/p256.wac",
    line: 111,
    snippet: "if (jacIsInfinity(q))",
    why: "jacAdd with the *second* operand at infinity. The ladder only ever adds a fixed " +
      "point to an accumulator, so the identity always arrives as the first operand and " +
      "line 110 catches it. Kept because jacAdd is exported and a caller could pass them " +
      "the other way round.",
  },
  {
    file: "packages/crypto/src/p256.wac",
    line: 121,
    snippet: "if (fpEquals(s1, s2)) { return jacDouble(p); }",
    why: "The doubling case inside jacAdd, for P + P. The ladder doubles the accumulator " +
      "before every conditional add, so the accumulator is never equal to the addend at " +
      "the point of adding. It is reachable through the exported jacAdd and through an " +
      "ECDSA verification where u1*G happens to equal u2*Q, which needs a signature " +
      "constructed for the purpose. This is the branch whose absence would be worst — " +
      "the general formula divides by zero for P + P — so it stays.",
  },
  {
    file: "packages/crypto/src/p256.wac",
    line: 286,
    snippet: "while (cmpBE(out, n) >= 0)",
    why: "scReduce's conditional subtraction, for a value at or above n. n is within " +
      "2^-32 of 2^256, so a uniformly random 32-byte value — a SHA-256 digest, or a " +
      "point's x-coordinate — lands above it about once in four billion times. Not " +
      "reachable by choosing inputs; reachable in the field, eventually, by somebody.",
  },
  {
    file: "packages/crypto/src/p256.wac",
    line: 288,
    snippet: "for (i32 i = 31; i >= 0; i--)",
    why: "The subtraction inside that same loop.",
  },
  {
    file: "packages/crypto/src/p256.wac",
    line: 290,
    snippet: "borrow = d < 0 ? 1 : 0;",
    why: "The borrow inside that same loop.",
  },
  {
    file: "packages/crypto/src/p256.wac",
    line: 318,
    snippet: "if (jacIsInfinity(shared)) { trap; }",
    why: "An ECDH result at infinity. P-256 has prime order, so the only point of small " +
      "order is the identity itself, and p256Decode rejects anything not on the curve — " +
      "so a validated peer point times a scalar in [1, n) cannot be the identity. Kept " +
      "because that argument depends on the validation above it staying correct.",
  },
  {
    file: "packages/crypto/src/p256.wac",
    line: 349,
    snippet: "if (jacIsInfinity(point)) { return false; }",
    why: "u1*G + u2*Q landing on the identity during verification. Constructible by an " +
      "attacker choosing r and s together, which is exactly why the check is here; not " +
      "constructible by accident, which is why no test drives it.",
  },
  {
    file: "packages/crypto/src/p256.wac",
    line: 371,
    snippet: "if (jacIsInfinity(point)) { return u8[0](); }",
    why: "k*G at infinity during signing, which needs k = 0 mod n — already rejected " +
      "above. FIPS 186-4 specifies the retry anyway.",
  },
  {
    file: "packages/crypto/src/p256.wac",
    line: 376,
    snippet: "if (isZeroBE(r)) { return u8[0](); }",
    why: "r = 0 during signing. FIPS 186-4 requires the retry; the probability is about " +
      "2^-256 and no test can produce it without solving for k.",
  },
  {
    file: "packages/crypto/src/p256.wac",
    line: 380,
    snippet: "if (isZeroBE(s)) { return u8[0](); }",
    why: "s = 0 during signing. As above.",
  },
];

const p256 = await instrument("packages/crypto/test/wac/p256_probe.wac");
{
  const g = <T extends (...a: never[]) => unknown>(n: string) => p256.mod[n] as T;
  const P = (1n << 256n) - (1n << 224n) + (1n << 192n) + (1n << 96n) - 1n;
  const N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n;
  const be = (v: bigint, m = P) => {
    const o = new Uint8Array(32);
    let x = ((v % m) + m) % m;
    for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xFFn); x >>= 8n; }
    return o;
  };
  const pubKey = g<(p: Uint8Array) => Uint8Array>("pubKey");
  const ecdh = g<(p: Uint8Array, q: Uint8Array) => Uint8Array>("ecdh");
  const verify = g<(p: Uint8Array, m: Uint8Array, s: Uint8Array) => boolean>("verify");
  const sign = g<(p: Uint8Array, m: Uint8Array, k: Uint8Array) => Uint8Array>("sign");
  const scalarBase = g<(k: Uint8Array) => Uint8Array>("scalarBase");

  // Field: the boundaries where the reduction's carry and fold paths differ.
  for (const v of [0n, 1n, P - 1n, (1n << 224n), (1n << 96n), (1n << 255n)]) {
    g<(a: Uint8Array, b: Uint8Array) => Uint8Array>("pAdd")(be(v), be(P - 1n));
    g<(a: Uint8Array, b: Uint8Array) => Uint8Array>("pSub")(be(v), be(P - 1n));
    g<(a: Uint8Array, b: Uint8Array) => Uint8Array>("pMul")(be(v), be(P - 2n));
    g<(a: Uint8Array) => Uint8Array>("pSquare")(be(v));
    g<(a: Uint8Array) => Uint8Array>("pInvert")(be(v));
    g<(a: Uint8Array) => Uint8Array>("pNeg")(be(v));
    g<(a: Uint8Array) => Uint8Array>("pRoundTrip")(be(v));
    g<(a: Uint8Array) => boolean>("pInRange")(be(v));
  }
  g<() => Uint8Array>("baseEncoded")();
  g<() => Uint8Array>("order")();

  // Curve: the general case, the doubling case, the identity, the negation case.
  const priv = be(12345n, N);
  const pub = pubKey(priv);
  scalarBase(be(2n, N));
  scalarBase(be(3n, N));
  mustTrap("n*G has no affine form", () => scalarBase(be(N, N + 1n)));
  scalarBase(be(N - 1n, N));
  ecdh(priv, pub);
  const msg = bytes(20, 70);
  const sig = sign(priv, msg, be(0xDEADBEEFn, N));
  verify(pub, msg, sig);
  const bad = Uint8Array.from(sig);
  bad[0] ^= 1;
  verify(pub, msg, bad);
  verify(pub, msg, new Uint8Array(63));
  verify(pub, msg, new Uint8Array(64));
  const nb = be(N, N + 1n);
  const bigR = Uint8Array.from(sig); bigR.set(nb, 0); verify(pub, msg, bigR);
  const bigS = Uint8Array.from(sig); bigS.set(nb, 32); verify(pub, msg, bigS);
  sign(priv, msg, new Uint8Array(32));
  mustTrap("p256 zero scalar", () => pubKey(new Uint8Array(32)));
  mustTrap("p256 scalar at n", () => pubKey(nb));
  const offCurve = Uint8Array.from(pub); offCurve[64] ^= 1;
  mustTrap("p256 off-curve point", () => ecdh(priv, offCurve));
  const badTag = Uint8Array.from(pub); badTag[0] = 3;
  mustTrap("p256 compressed point", () => ecdh(priv, badTag));
  mustTrap("p256 short point", () => ecdh(priv, new Uint8Array(64)));
  // A coordinate at or above p. P - 1 is still *in* the field, so it exercises the
  // curve check rather than the range check; all-ones is above p and exercises both.
  const overP = Uint8Array.from(pub);
  for (let i = 1; i <= 32; i++) overP[i] = 0xFF;
  mustTrap("p256 x outside the field", () => ecdh(priv, overP));
  const overPy = Uint8Array.from(pub);
  for (let i = 33; i <= 64; i++) overPy[i] = 0xFF;
  mustTrap("p256 y outside the field", () => ecdh(priv, overPy));
  mustTrap("p256 short private key", () => pubKey(new Uint8Array(31)));
  mustTrap("p256 short key for ecdh", () => ecdh(new Uint8Array(31), pub));
  mustTrap("p256 short key for sign", () => sign(new Uint8Array(31), msg, be(7n, N)));
}

const rsa = await instrument("packages/crypto/test/wac/rsa_probe.wac");
{
  const g = <T extends (...a: never[]) => unknown>(n: string) => rsa.mod[n] as T;
  const modExp = g<(b: Uint8Array, e: Uint8Array, n: Uint8Array) => Uint8Array>("modExp");
  const vPkcs1 = g<(n: Uint8Array, e: Uint8Array, m: Uint8Array, s: Uint8Array, h: number) => boolean>("verifyPkcs1");
  const vPss = g<(n: Uint8Array, e: Uint8Array, m: Uint8Array, s: Uint8Array, h: number, sl: number) => boolean>("verifyPss");
  const be = (v: bigint, len: number) => {
    const o = new Uint8Array(len);
    let x = v;
    for (let i = len - 1; i >= 0; i--) { o[i] = Number(x & 0xFFn); x >>= 8n; }
    return o;
  };
  modExp(be(3n, 32), be(5n, 32), be(7n, 32));
  modExp(be(0n, 32), be(65537n, 32), be(3233n, 32));

  // Real keys and signatures, so the accepting path runs; the rejecting paths need only
  // the shapes. Generated here rather than fixed, because a fixed key would make this
  // file the only place the modulus size is pinned.
  for (const [name, hash, hashLen] of [["RSASSA-PKCS1-v1_5", "SHA-256", 32],
                                        ["RSASSA-PKCS1-v1_5", "SHA-384", 48],
                                        ["RSASSA-PKCS1-v1_5", "SHA-512", 64]] as const) {
    const kp = await crypto.subtle.generateKey(
      { name, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash },
      true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const b64u = (x: string) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const n = b64u(jwk.n!), e = b64u(jwk.e!);
    const msg = bytes(24, 80);
    const sig = new Uint8Array(await crypto.subtle.sign(name, kp.privateKey, msg as BufferSource));
    vPkcs1(n, e, msg, sig, hashLen);
    const bad = Uint8Array.from(sig);
    bad[3] ^= 1;
    vPkcs1(n, e, msg, bad, hashLen);
    vPkcs1(n, e, msg, new Uint8Array(10), hashLen);   // wrong length
    vPkcs1(n, e, msg, n, hashLen);                    // s = n
    vPkcs1(new Uint8Array(256), e, msg, sig, hashLen); // modulus zero
  }
  {
    const kp = await crypto.subtle.generateKey(
      { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const b64u = (x: string) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const n = b64u(jwk.n!), e = b64u(jwk.e!);
    const msg = bytes(24, 81);
    for (const saltLength of [0, 32]) {
      const sig = new Uint8Array(await crypto.subtle.sign(
        { name: "RSA-PSS", saltLength }, kp.privateKey, msg as BufferSource));
      vPss(n, e, msg, sig, 32, saltLength);
      const bad = Uint8Array.from(sig);
      bad[7] ^= 1;
      vPss(n, e, msg, bad, 32, saltLength);
      const badTrailer = Uint8Array.from(sig);
      badTrailer[badTrailer.length - 1] ^= 0xFF;
      vPss(n, e, msg, badTrailer, 32, saltLength);
    }
    vPss(n, e, msg, new Uint8Array(10), 32, 32);
    vPss(n, e, msg, n, 32, 32);
    vPss(new Uint8Array(256), e, msg, new Uint8Array(256), 32, 32);
    vPss(n, e, msg, new Uint8Array(256), 32, 250);    // salt too long for the modulus
    // A modulus too small to hold the padding at all: 64 bytes cannot carry a SHA-512
    // DigestInfo plus eight padding bytes, so the length check fires before any work.
    const tiny = new Uint8Array(64);
    tiny[0] = 0xC0;
    vPkcs1(tiny, e, msg, new Uint8Array(64), 64);
  }
}

report([run, curve, p256, rsa], "packages/crypto/", { verbose });

const missed = new Set<string>();
for (const r of [run, curve, p256, rsa]) {
  const counts = r.counts();
  const hit = new Map<string, boolean>();
  for (const p of r.points) {
    if (!p.file.startsWith("packages/crypto/")) continue;
    const key = `${p.file}:${p.line}:${p.col}:${p.kind}`;
    hit.set(key, (hit.get(key) ?? false) || counts[p.index] > 0);
  }
  for (const [key, ok] of hit) if (!ok) missed.add(key.split(":").slice(0, 2).join(":"));
}
// A point covered by one probe and missed by the other is covered; merge before judging.
for (const r of [run, curve, p256, rsa]) {
  const counts = r.counts();
  for (const p of r.points) {
    if (counts[p.index] > 0) missed.delete(`${p.file}:${p.line}`);
  }
}

let failed = false;
for (const u of UNREACHED) {
  const where = `${u.file}:${u.line}`;
  const source = (await Deno.readTextFile(u.file)).split("\n")[u.line - 1] ?? "";
  if (!source.includes(u.snippet)) {
    console.log(`\n${where} no longer holds ${JSON.stringify(u.snippet)} — it holds:\n  ${source.trim()}`);
    console.log("  The UNREACHED entry has drifted onto the wrong line; fix the line number.");
    failed = true;
  } else if (!missed.has(where)) {
    console.log(`\n${where} is listed as unreached but was covered — drop the entry.`);
    failed = true;
  } else {
    console.log(`\nexcluded as unreached: ${where}  ${u.snippet}\n  ${u.why}`);
  }
}
const unexpected = [...missed].filter(m => !UNREACHED.some(u => `${u.file}:${u.line}` === m));
if (unexpected.length > 0) {
  console.log(`\n${unexpected.length} branch point(s) uncovered:`);
  for (const m of unexpected.sort()) console.log(`  ${m}`);
  failed = true;
}
if (failed) Deno.exit(1);
