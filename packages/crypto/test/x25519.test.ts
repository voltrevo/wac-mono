// X25519 against RFC 7748 and against WebCrypto.
//
// Three independent checks, which is more than usual because a scalar multiplication has
// no partial credit: an implementation is either right for essentially every input or
// wrong for essentially every input, and the failure mode in between — right for most,
// wrong for a few — is exactly what a single vector cannot see.
//
//   RFC 7748 §5, §5.2, §6.1  the published vectors, including the iterated one
//   WebCrypto                a different implementation, on random keys, both directions
//   algebraic properties     that a shared secret is symmetric, and that clamping bites
//
// The iterated test is the one worth having. It chains a thousand scalar
// multiplications, each feeding the last's output back in as both scalar and point, so
// any input for which the ladder is wrong poisons everything after it. A single vector
// checks one path through the ladder; this checks a thousand, including the low-order
// and near-boundary points that turn up on their own along the way.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/crypto/test/wac/curve25519_probe.wac");
const x25519 = mod.x25519 as (k: Uint8Array, u: Uint8Array) => Uint8Array;
const x25519Base = mod.x25519Base as (k: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.replace(/\s/g, "").match(/../g)!.map(h => parseInt(h, 16)));

Deno.test("x25519: the RFC 7748 section 5 scalar multiplication vectors", () => {
  const cases: [string, string, string][] = [
    ["a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4",
     "e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c",
     "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552"],
    ["4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d",
     "e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493",
     "95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957"],
  ];
  for (const [k, u, want] of cases) {
    const got = hex(x25519(unhex(k), unhex(u)));
    if (got !== want) throw new Error(`scalar ${k.slice(0, 16)}…\n  got  ${got}\n  want ${want}`);
  }
});

Deno.test("x25519: the RFC 7748 section 5.2 iterated vectors", () => {
  // k = u = the base point encoding; then repeatedly k, u = X25519(k, u), k.
  let k: Uint8Array<ArrayBuffer> = unhex("0900000000000000000000000000000000000000000000000000000000000000");
  let u: Uint8Array<ArrayBuffer> = k;
  const after = new Map<number, string>([
    [1, "422c8e7a6227d7bca1350b3e2bb7279f7897b87bb6854b783c60e80311ae3079"],
    [1000, "684cf59ba83309552800ef566f2f4d3c1c3887c49360e3875f2eb94d99532c51"],
  ]);
  // The RFC also gives the value after 1,000,000 iterations. At roughly two milliseconds
  // a multiplication that is half an hour, which does not belong in a test suite — the
  // thousandth already depends on every one before it, so the extra decimal places buy
  // less than the runtime costs.
  for (let i = 1; i <= 1000; i++) {
    const next = Uint8Array.from(x25519(k, u));
    u = k;
    k = next;
    const want = after.get(i);
    if (want !== undefined && hex(k) !== want) {
      throw new Error(`iteration ${i}\n  got  ${hex(k)}\n  want ${want}`);
    }
  }
});

Deno.test("x25519: the RFC 7748 section 6.1 Diffie-Hellman exchange", () => {
  const aPriv = unhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  const bPriv = unhex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
  const aPub = x25519Base(aPriv);
  const bPub = x25519Base(bPriv);
  if (hex(aPub) !== "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a") {
    throw new Error(`alice's public key: ${hex(aPub)}`);
  }
  if (hex(bPub) !== "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f") {
    throw new Error(`bob's public key: ${hex(bPub)}`);
  }
  const want = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";
  if (hex(x25519(aPriv, bPub)) !== want) throw new Error(`a*B: ${hex(x25519(aPriv, bPub))}`);
  if (hex(x25519(bPriv, aPub)) !== want) throw new Error(`b*A: ${hex(x25519(bPriv, aPub))}`);
});

Deno.test("x25519: agrees with WebCrypto on random keys, in both directions", async () => {
  // WebCrypto generates the keypair, so the scalars are outside our control and outside
  // any pattern this file might accidentally favour. Two things are checked per round:
  // that our public key derived from *their* private scalar matches the one they
  // exported, and that a full exchange produces the same secret on both sides.
  for (let round = 0; round < 8; round++) {
    const theirs = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
    const theirPub = new Uint8Array(await crypto.subtle.exportKey("raw", theirs.publicKey));
    // The last 32 bytes of a PKCS#8 X25519 key are the raw scalar.
    const theirPriv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", theirs.privateKey)).slice(-32);

    const derived = x25519Base(theirPriv);
    if (hex(derived) !== hex(theirPub)) {
      throw new Error(`round ${round}: our public key from their scalar\n  got  ${hex(derived)}\n  want ${hex(theirPub)}`);
    }

    const ourPriv = Uint8Array.from({ length: 32 }, (_, i) => (round * 37 + i * 11 + 5) & 0xFF);
    const ourPub = x25519Base(ourPriv);
    const ourPubKey = await crypto.subtle.importKey("raw", ourPub as BufferSource, { name: "X25519" }, false, []);
    const theirSecret = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "X25519", public: ourPubKey }, theirs.privateKey, 256));
    const ourSecret = x25519(ourPriv, theirPub);
    if (hex(ourSecret) !== hex(theirSecret)) {
      throw new Error(`round ${round}: shared secret\n  ours   ${hex(ourSecret)}\n  theirs ${hex(theirSecret)}`);
    }
  }
});

Deno.test("x25519: clamping, so that distinct scalars can share a public key", () => {
  // RFC 7748 §5 clears the low three bits and the top bit, and sets bit 254. Scalars
  // differing only in those bits must therefore agree — which is the observable
  // consequence of clamping, and the thing that breaks if the mask is applied to the
  // wrong byte or the wrong end.
  const base = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 7) & 0xFF);
  const want = hex(x25519Base(base));

  const lowBitsSet = Uint8Array.from(base);
  lowBitsSet[0] |= 7;
  const lowBitsClear = Uint8Array.from(base);
  lowBitsClear[0] &= ~7;
  const topSet = Uint8Array.from(base);
  topSet[31] |= 0x80;
  const bit254Clear = Uint8Array.from(base);
  bit254Clear[31] &= ~0x40;

  for (const [label, k] of [["low three bits", lowBitsSet], ["low bits cleared", lowBitsClear],
                            ["bit 255 set", topSet], ["bit 254 cleared", bit254Clear]] as const) {
    if (hex(x25519Base(k)) !== want) throw new Error(`${label} changed the public key`);
  }

  // And the clamp must not touch anything else: flipping bit 3 is a different scalar.
  const different = Uint8Array.from(base);
  different[0] ^= 8;
  if (hex(x25519Base(different)) === want) throw new Error("bit 3 was clamped away, and should not be");
});

Deno.test("x25519: low-order points produce an all-zero secret", () => {
  // RFC 7748 §6.1: "protocols MAY check for the all-zero value", which presumes an
  // implementation produces it rather than something else. These are the small-order
  // u-coordinates from the curve's cofactor-8 subgroup; multiplying any of them by a
  // clamped scalar lands on the identity, whose u-coordinate encodes as zero.
  const lowOrder = [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0100000000000000000000000000000000000000000000000000000000000000",
    "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
    "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  ];
  const zero = "0".repeat(64);
  const scalar = Uint8Array.from({ length: 32 }, (_, i) => (i * 29 + 3) & 0xFF);
  for (const u of lowOrder) {
    const got = hex(x25519(scalar, unhex(u)));
    if (got !== zero) throw new Error(`low-order point ${u.slice(0, 16)}… gave ${got}, expected all zero`);
  }
});

Deno.test("x25519: a u-coordinate with bit 255 set is the same point", () => {
  // The masking requirement again, this time through the curve rather than the field: a
  // peer that sets the unused top bit must not thereby change the shared secret, or two
  // conforming implementations would disagree over a bit neither of them uses.
  const scalar = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xFF);
  const u = x25519Base(Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 2) & 0xFF));
  const uTopSet = Uint8Array.from(u);
  uTopSet[31] |= 0x80;
  if (hex(x25519(scalar, u)) !== hex(x25519(scalar, uTopSet))) {
    throw new Error("setting bit 255 of the u-coordinate changed the result");
  }
});

Deno.test("x25519: rejects keys that are not 32 bytes", () => {
  const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  const ok = new Uint8Array(32);
  for (const n of [0, 31, 33, 64]) {
    if (!traps(() => x25519(new Uint8Array(n), ok))) throw new Error(`a ${n}-byte scalar was accepted`);
    if (!traps(() => x25519(ok, new Uint8Array(n)))) throw new Error(`a ${n}-byte u-coordinate was accepted`);
  }
});
