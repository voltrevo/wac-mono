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

// ── Documents for the ported chain ───────────────────────────────────────────
//
// Real RSA keys and real signatures, built here rather than captured: the chutney testnet
// lives in /tmp and does not survive a container recreation. Every signature below is
// produced with `privateEncrypt` over a bare digest, which is the shape tor uses.

const AUTHORITIES = [0, 1, 2].map(() => ({
  identity: keyMaterial(),
  signing: keyMaterial(),
}));
/** A second signing key for authority 0, as if it had rotated. */
const ROTATED = keyMaterial();

const pem = (der: Uint8Array, label: string) =>
  `-----BEGIN ${label}-----\n` +
  (btoa(String.fromCharCode(...der)).match(/.{1,64}/g) ?? []).join("\n") +
  `\n-----END ${label}-----\n`;

const sha1 = async (b: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-1", b as BufferSource));
const hex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();

const signBare = (k: CryptoKey | ReturnType<typeof keyMaterial>["privateKey"], d: Uint8Array) =>
  new Uint8Array(privateEncrypt({ key: k as never, padding: constants.RSA_PKCS1_PADDING }, d));

/** A certificate whose signing key may be somebody else's, for the tampered case. */
async function certFor(a: typeof AUTHORITIES[0], signingDer: Uint8Array) {
  const body =
    `dir-key-certificate-version 3\n` +
    `fingerprint ${hex(await sha1(a.identity.der))}\n` +
    `dir-identity-key\n${pem(a.identity.der, "RSA PUBLIC KEY")}` +
    `dir-signing-key\n${pem(signingDer, "RSA PUBLIC KEY")}` +
    `dir-key-certification\n`;
  const sig = signBare(a.identity.privateKey, await sha1(new TextEncoder().encode(body)));
  return body + pem(sig, "SIGNATURE");
}

/** A consensus signed by every authority, over whatever body it is given. */
async function signConsensus(body: string) {
  let out = body;
  for (const a of AUTHORITIES) {
    out += `directory-signature sha256 ${hex(await sha1(a.identity.der))} ` +
      `${hex(await sha1(a.signing.der))}\n`;
    const upTo = out.slice(0, out.indexOf("\ndirectory-signature ") + "\ndirectory-signature ".length);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(upTo)),
    );
    out += pem(signBare(a.signing.privateKey, digest), "SIGNATURE");
  }
  return out;
}

const bodyFor = (flags: string, digest: string) =>
  "network-status-version 3 microdesc\n" +
  "valid-after 2026-08-02 00:00:00\n" +
  "fresh-until 2026-08-03 12:00:00\n" +
  "valid-until 2026-08-04 00:00:00\n" +
  `r alpha AAAAAAAAAAAAAAAAAAAAAAAAAAA 2026-08-02 09:00:00 10.0.0.1 9001 0\n` +
  `m ${digest}\n` +
  `s ${flags}\n` +
  "w Bandwidth=100\n";

const GOOD = bodyFor("Exit Fast Guard Running Stable Valid", "abcdefghijklmnopqrstuvwxyz012345678901234567");
const docs = [
  await signConsensus(GOOD),
  (await Promise.all(AUTHORITIES.map((a) => certFor(a, a.signing.der)))).join(""),
  // Signed correctly, then a flag changed underneath: the signature covers the old bytes.
  (await signConsensus(GOOD)).replace("Exit Fast", "Exit Guard"),
  (await signConsensus(GOOD)).replace("abcdefghij", "ABCDEFGHIJ"),
  // The first authority's certificate with the second's signing key substituted *after*
  // signing, so the certification no longer covers it. Re-signing instead would have meant
  // the authority genuinely certified that key, which is not an attack — it is a decision
  // it is entitled to make, and my first attempt at this fixture made exactly that mistake.
  (await Promise.all(AUTHORITIES.map((a) => certFor(a, a.signing.der)))).join("")
    .replace(pem(AUTHORITIES[0].signing.der, "RSA PUBLIC KEY"),
             pem(AUTHORITIES[1].signing.der, "RSA PUBLIC KEY")),
  // Authority 0 with two certificates, its rotated key *last*. The consensus names the
  // first one's key digest, so a chain that matched on identity alone would land on the
  // rotated certificate and fail to attribute a perfectly good signature. Authorities do
  // rotate signing keys and cached-certs carries several per authority, so this is the
  // ordinary case rather than an attack.
  (await Promise.all(AUTHORITIES.map((a) => certFor(a, a.signing.der)))).join("") +
    await certFor(AUTHORITIES[0], ROTATED.der),
];

const enc2 = new TextEncoder();
const docBytes = docs.map((d) => enc2.encode(d));
// Fingerprint sets travel as newline-joined bytes: `fn[string[](i32)]` is not a shape
// bindgen marshals, and a byte blob the wac side splits is one less thing to be clever about.
const nameSets = [
  (await Promise.all(AUTHORITIES.map(async (a) => hex(await sha1(a.identity.der))))).join("\n"),
  "0".repeat(40),
].map((s) => enc2.encode(s + "\n"));

await wacTestRun("packages/tor/test/wac/consensus_test.wac", "consensus",
  [parts(key), sign, parts(other), (n: number) => docBytes[n], (n: number) => nameSets[n]]);
