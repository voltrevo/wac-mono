// ML-KEM-768 against WebCrypto.
//
// The strongest oracle in this package, and worth saying why. WebCrypto exports an
// ML-KEM private key as its 64-byte seed, and FIPS 203 key generation is a deterministic
// function of that seed — so this can compare *bytes*, not behaviour. An encapsulation
// key that matches WebCrypto's to all 1184 bytes means SHA3-512, the seed split, the
// SHAKE128 rejection sampling, the centred binomial noise, the NTT, the matrix multiply
// and the twelve-bit packing are all simultaneously right. Nothing weaker would pin the
// NTT at all: it is an internal representation, and two different transforms produce
// keys that work perfectly with themselves.
//
// Then both directions of encapsulation, because a KEM has two halves that can be
// separately wrong, and the implicit rejection, which is the part that is easy to
// implement as an error return and must not be.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/crypto/test/wac/mlkem_probe.wac");
const keyGen = mod.kemKeyGen as (seed: Uint8Array) => Uint8Array;
const encaps = mod.kemEncaps as (ek: Uint8Array, m: Uint8Array) => Uint8Array;
const decaps = mod.kemDecaps as (dk: Uint8Array, ct: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

const EK_LEN = 1184, DK_LEN = 2400, CT_LEN = 1088;

/** WebCrypto's ML-KEM-768, with the non-standard-typed methods narrowed. */
const subtle = crypto.subtle as unknown as {
  encapsulateBits(a: unknown, k: CryptoKey): Promise<{ ciphertext: ArrayBuffer; sharedKey: ArrayBuffer }>;
  decapsulateBits(a: unknown, k: CryptoKey, c: BufferSource): Promise<ArrayBuffer>;
};

async function webcryptoKey() {
  const kp = await crypto.subtle.generateKey(
    { name: "ML-KEM-768" } as AlgorithmIdentifier, true,
    ["encapsulateBits", "decapsulateBits"] as unknown as KeyUsage[]) as CryptoKeyPair;
  return {
    kp,
    seed: new Uint8Array(await crypto.subtle.exportKey("raw-seed" as "raw", kp.privateKey)),
    ek: new Uint8Array(await crypto.subtle.exportKey("raw-public" as "raw", kp.publicKey)),
  };
}

Deno.test("mlkem: key generation matches WebCrypto byte for byte", async () => {
  for (let round = 0; round < 4; round++) {
    const { seed, ek } = await webcryptoKey();
    if (seed.length !== 64) throw new Error(`expected a 64-byte seed, got ${seed.length}`);
    const ours = keyGen(seed);
    if (ours.length !== EK_LEN + DK_LEN) throw new Error(`keyGen returned ${ours.length} bytes`);
    const ourEk = ours.subarray(0, EK_LEN);
    if (hex(ourEk) !== hex(ek)) {
      throw new Error(`round ${round}: encapsulation key differs\n  ours   ${hex(ourEk).slice(0, 80)}\n  theirs ${hex(ek).slice(0, 80)}`);
    }
  }
});

Deno.test("mlkem: our ciphertext decapsulates in WebCrypto", async () => {
  const { kp, seed } = await webcryptoKey();
  const ours = keyGen(seed);
  const ek = ours.subarray(0, EK_LEN);
  for (let round = 0; round < 3; round++) {
    const m = crypto.getRandomValues(new Uint8Array(32));
    const out = encaps(ek, m);
    if (out.length !== 32 + CT_LEN) throw new Error(`encaps returned ${out.length} bytes`);
    const shared = out.subarray(0, 32);
    const ct = out.subarray(32);
    const theirs = new Uint8Array(await subtle.decapsulateBits({ name: "ML-KEM-768" }, kp.privateKey, ct as BufferSource));
    if (hex(shared) !== hex(theirs)) {
      throw new Error(`round ${round}: shared secrets differ\n  ours   ${hex(shared)}\n  theirs ${hex(theirs)}`);
    }
  }
});

Deno.test("mlkem: WebCrypto's ciphertext decapsulates here", async () => {
  // The other direction, and not redundant: encapsulation and decapsulation are
  // different code, and a transform that is self-consistently wrong would pass the test
  // above while failing this one.
  const { kp, seed } = await webcryptoKey();
  const ours = keyGen(seed);
  const dk = ours.subarray(EK_LEN);
  for (let round = 0; round < 3; round++) {
    const them = await subtle.encapsulateBits({ name: "ML-KEM-768" }, kp.publicKey);
    const got = decaps(dk, new Uint8Array(them.ciphertext));
    if (hex(got) !== hex(new Uint8Array(them.sharedKey))) {
      throw new Error(`round ${round}: decapsulated the wrong secret`);
    }
  }
});

Deno.test("mlkem: encapsulation is deterministic in its randomness", () => {
  // `m` is a parameter rather than generated inside, for the same reason ECDSA's `k` is.
  // The consequence is testable: the same m must give the same ciphertext, and a
  // different m a different one. An implementation that quietly drew its own randomness
  // would fail the first of those and interoperate anyway.
  const seed = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 1) & 0xFF);
  const ek = keyGen(seed).subarray(0, EK_LEN);
  const m1 = Uint8Array.from({ length: 32 }, (_, i) => i);
  const m2 = Uint8Array.from(m1);
  m2[31] ^= 1;
  if (hex(encaps(ek, m1)) !== hex(encaps(ek, m1))) throw new Error("encapsulation is not deterministic");
  if (hex(encaps(ek, m1)) === hex(encaps(ek, m2))) throw new Error("two messages gave the same ciphertext");
});

Deno.test("mlkem: a corrupted ciphertext yields a different secret, not a failure", () => {
  // The Fujisaki-Okamoto transform's whole point. Decapsulation re-encrypts and compares;
  // a mismatch must return a secret derived from the private key's rejection value, never
  // an error. Reporting failure would hand an attacker a decryption oracle, which is the
  // attack the transform exists to deny — so "it threw" is a bug here, not a defence.
  const seed = Uint8Array.from({ length: 64 }, (_, i) => (i * 13 + 5) & 0xFF);
  const both = keyGen(seed);
  const ek = both.subarray(0, EK_LEN);
  const dk = both.subarray(EK_LEN);
  const out = encaps(ek, Uint8Array.from({ length: 32 }, (_, i) => i * 3));
  const real = out.subarray(0, 32);
  const ct = out.subarray(32);
  if (hex(decaps(dk, ct)) !== hex(real)) throw new Error("a good ciphertext did not decapsulate");

  for (const i of [0, 1, 500, CT_LEN - 1]) {
    const bad = Uint8Array.from(ct);
    bad[i] ^= 1;
    let got: string;
    try {
      got = hex(decaps(dk, bad));
    } catch {
      throw new Error(`decapsulation threw on a corrupted ciphertext at byte ${i}; it must not`);
    }
    if (got === hex(real)) throw new Error(`byte ${i} flipped and the secret did not change`);
    // And the rejection secret is a function of the key and the ciphertext, so it repeats.
    if (got !== hex(decaps(dk, bad))) throw new Error(`the rejection secret at byte ${i} is not deterministic`);
  }
  // Two different corruptions must give two different rejection secrets, or the value is
  // not bound to the ciphertext.
  const badA = Uint8Array.from(ct);
  badA[0] ^= 1;
  const badB = Uint8Array.from(ct);
  badB[1] ^= 1;
  if (hex(decaps(dk, badA)) === hex(decaps(dk, badB))) {
    throw new Error("the rejection secret ignores the ciphertext");
  }
});

Deno.test("mlkem: rejects malformed keys and ciphertexts", () => {
  const seed = new Uint8Array(64);
  const both = keyGen(seed);
  const ek = both.subarray(0, EK_LEN);
  const dk = both.subarray(EK_LEN);
  const m = new Uint8Array(32);

  for (const n of [0, 63, 65]) {
    if (!traps(() => keyGen(new Uint8Array(n)))) throw new Error(`accepted a ${n}-byte seed`);
  }
  for (const n of [0, EK_LEN - 1, EK_LEN + 1]) {
    if (!traps(() => encaps(new Uint8Array(n), m))) throw new Error(`accepted a ${n}-byte encapsulation key`);
  }
  // Both sides of the length, not just the short one. A short message runs off the end
  // of the array and traps whatever the guard does; a long one has its tail ignored, so
  // encapsulating under a 33-byte "message" would silently mean its first 32 bytes.
  for (const n of [0, 31, 33, 64]) {
    if (!traps(() => encaps(ek, new Uint8Array(n)))) throw new Error(`accepted a ${n}-byte message`);
  }
  for (const n of [0, DK_LEN - 1, DK_LEN + 1]) {
    if (!traps(() => decaps(new Uint8Array(n), new Uint8Array(CT_LEN)))) {
      throw new Error(`accepted a ${n}-byte decapsulation key`);
    }
  }
  for (const n of [0, CT_LEN - 1, CT_LEN + 1]) {
    if (!traps(() => decaps(dk, new Uint8Array(n)))) throw new Error(`accepted a ${n}-byte ciphertext`);
  }
});

Deno.test("mlkem: rejects an encapsulation key whose coefficients are out of range", () => {
  // FIPS 203 §7.2 requires the modulus check: every twelve-bit coefficient must be below
  // q. The test is that re-encoding what was decoded gives back the original bytes, which
  // fails exactly when some coefficient was 3329 or more. Skipping it lets a peer choose
  // arithmetic outside the ring.
  const seed = Uint8Array.from({ length: 64 }, (_, i) => i);
  const ek = Uint8Array.from(keyGen(seed).subarray(0, EK_LEN));
  const m = new Uint8Array(32);
  encaps(ek, m);   // the genuine key is accepted

  // 0xFFF is 4095, comfortably above q, in the first coefficient's twelve bits.
  const bad = Uint8Array.from(ek);
  bad[0] = 0xFF;
  bad[1] = bad[1] | 0x0F;
  if (!traps(() => encaps(bad, m))) throw new Error("accepted a coefficient at or above q");
});
