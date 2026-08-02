// Registers the wac-side consensus verification tests.
//
// The oracle is node's RSA. `privateEncrypt` with PKCS#1 v1.5 padding over a bare digest is
// exactly the signature shape Tor uses — no DER DigestInfo — so this is a differential
// against an implementation that has never seen ours, which for a signature check is the
// only kind worth having.
import { createPrivateKey, createPublicKey, constants, privateEncrypt } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

function keyMaterial() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  // PKCS#1 RSAPublicKey DER — the same encoding a Tor authority key is PEM-wrapped around.
  const der = new Uint8Array(publicKey.export({ type: "pkcs1", format: "der" }));
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const b64u = (s: string) =>
    Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return { der, n: b64u(jwk.n), e: b64u(jwk.e), privateKey };
}

const key = keyMaterial();
const other = keyMaterial();

const parts = (k: typeof key) => (which: number): Uint8Array =>
  which === 0 ? k.der : which === 1 ? k.n : k.e;

const sign = (digest: Uint8Array): Uint8Array =>
  new Uint8Array(privateEncrypt(
    { key: key.privateKey, padding: constants.RSA_PKCS1_PADDING },
    digest,
  ));

await wacTestRun("packages/tor/test/wac/consensus_test.wac", "consensus",
  [parts(key), sign, parts(other)]);
