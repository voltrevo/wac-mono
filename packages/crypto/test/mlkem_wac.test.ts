// Generates ML-KEM vectors with WebCrypto and hands them to the wac tests.
//
// The one place in this conversion where the oracle could not become a callback.
// WebCrypto's ML-KEM is asynchronous and a wasm call cannot await; OpenSSL 3.5 has ML-KEM
// and runs synchronously, but its CLI will not export a key's *seed* — and the seed is
// what makes this the strongest test in the package, because FIPS 203 key generation is a
// deterministic function of it and the comparison can therefore be byte for byte.
//
// So the host does the part only it can and passes the results in as data. The vectors are
// generated fresh on every run, so they are neither stale nor committed.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const SEED = 64, EK = 1184, CT = 1088, SS = 32;

/** WebCrypto's ML-KEM-768, with the not-yet-typed methods narrowed. */
const subtle = crypto.subtle as unknown as {
  encapsulateBits(a: unknown, k: CryptoKey): Promise<{ ciphertext: ArrayBuffer; sharedKey: ArrayBuffer }>;
};

const ROUNDS = 3;
const vectors = new Uint8Array(ROUNDS * (SEED + EK + CT + SS));
for (let r = 0; r < ROUNDS; r++) {
  const kp = await crypto.subtle.generateKey(
    { name: "ML-KEM-768" } as AlgorithmIdentifier, true,
    ["encapsulateBits", "decapsulateBits"] as unknown as KeyUsage[]) as CryptoKeyPair;
  const seed = new Uint8Array(await crypto.subtle.exportKey("raw-seed" as "raw", kp.privateKey));
  const ek = new Uint8Array(await crypto.subtle.exportKey("raw-public" as "raw", kp.publicKey));
  const enc = await subtle.encapsulateBits({ name: "ML-KEM-768" }, kp.publicKey);
  if (seed.length !== SEED) throw new Error(`expected a ${SEED}-byte seed, got ${seed.length}`);
  if (ek.length !== EK) throw new Error(`expected a ${EK}-byte key, got ${ek.length}`);

  const at = r * (SEED + EK + CT + SS);
  vectors.set(seed, at);
  vectors.set(ek, at + SEED);
  vectors.set(new Uint8Array(enc.ciphertext), at + SEED + EK);
  vectors.set(new Uint8Array(enc.sharedKey), at + SEED + EK + CT);
}

await wacTestRun("packages/crypto/test/wac/mlkem_test.wac", "mlkem", [vectors]);
