// Registers the wac-side onion service descriptor tests: the document a service publishes.
//
// The oracle is `test/data/hsdesc_generated.json`, produced by `src/genhsdesc.wac` and checked with
// `tools/hsdesc-probe.c`, which puts it through tor's own `hs_desc_decode_plaintext`. That entry
// point verifies the version, the lifetime, the signing-key **certificate** and the signature over
// the document, and treats the `superencrypted` object as opaque — which is what lets the outer shell
// be pinned before either encrypted layer exists.
//
// What ACCEPTED is worth here, measured by corrupting the committed bytes and asking tor:
//
//   | mutation | tor |
//   |---|---|
//   | unmodified | ACCEPTED |
//   | one character of the signature | REJECTED |
//   | the certificate's own signature | REJECTED |
//   | the certificate's expiry | REJECTED |
//   | the certified key | REJECTED |
//   | `revision-counter` after signing | REJECTED |
//   | `descriptor-lifetime` after signing | REJECTED |
//   | one byte of the superencrypted object | REJECTED |
//   | `hs-descriptor 4` | REJECTED |
//   | truncated before the signature | REJECTED |
//
// And for the middle layer, through `hs_desc_decode_superencrypted` — tor's own decoder chains the
// three stages in that order, so stopping after two is a supported position rather than a trick:
//
//   | mutation | tor |
//   |---|---|
//   | unmodified | ACCEPTED, 16 auth clients, 64-byte inner blob |
//   | another service's subcredential | REJECTED |
//   | one character of the superencrypted blob | REJECTED |
//   | the revision counter, which keys the layer | REJECTED |
//
// And the whole thing, through `hs_desc_decode_descriptor`. **Read the count, not the verdict.** tor
// *drops* an introduction point it cannot validate and returns success for the descriptor, so
// ACCEPTED with `intro_points: 0` is a failure wearing a success:
//
//   | how the descriptor was built | tor |
//   |---|---|
//   | correctly | ACCEPTED, `intro_points: 1` |
//   | auth-key cert signed by the blinded key | ACCEPTED, **`intro_points: 0`** |
//   | auth-key cert with the wrong cert type | ACCEPTED, **`intro_points: 0`** |
//   | enc-key-cert certifying the curve25519 key itself | ACCEPTED, `intro_points: 1` |
//
// That last row is a statement about **tor**, not about us: it validates the cross-certificate's
// signature and type but never checks that the key inside it is the ed25519 form of the encryption
// key. So this oracle cannot confirm the proposal 228 conversion — `routerdesc_wac.test.ts` pins that
// against tor's own vectors, and the conversion is used here on that authority rather than this one.
//
// So this verdict is a strong one — unlike a microdescriptor's, where only the digest discriminates.
// Everything in the document is covered by either the signature or the certificate.
//
// One of those rows was nearly recorded wrongly. An early run reported "one character of the
// certificate — ACCEPTED", which looked like a real gap; the string being replaced was from the
// *previous* generated document and appeared nowhere in the current one, so the mutation changed
// nothing. A mutation that does not mutate is indistinguishable from a surviving fault, and the only
// defence is to assert that the bytes actually changed.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const H_DESCRIPTOR = 0; // the document tor decoded, byte for byte
const H_CERT = 1;
const H_SUPERENCRYPTED = 2;
const H_SIGN_SEED = 3;
const H_SIGN_PUBLIC = 4;
const H_BLIND_SEED = 5;
const H_BLIND_PUBLIC = 6;
const H_NUM = 7; // a[0]: 0 lifetime, 1 revision, 2 signedSpanLen, 3 middleLen — 4 bytes big-endian
const H_SUBCRED = 8;
const H_EPHEMERAL = 9;
const H_SALT = 10;
const H_INNER = 11;
const H_CLIENT = 12; // a[0]=i: the i-th decoy client, 40 bytes
const H_CLIENT_COUNT = 13;
const H_INNER_SALT = 14;
const H_LINK_SPECS = 15;
const H_IP_NTOR = 16;
const H_IP_ENC = 17;
const H_IP_ENC_ED = 18;
const H_AUTH_CERT = 19;
const H_ENC_CERT = 20;

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/hsdesc_generated.json", import.meta.url)),
) as {
  descriptor: string;
  cert: string;
  superencrypted: string;
  signSeed: string;
  signPublic: string;
  blindSeed: string;
  blindPublic: string;
  lifetimeMinutes: number;
  revision: number;
  signedSpanLen: number;
  subcredential: string;
  ephemeral: string;
  salt: string;
  inner: string;
  middleLen: number;
  innerSalt: string;
  linkSpecifiers: string;
  ipNtor: string;
  ipEnc: string;
  ipEncEd: string;
  authCert: string;
  encCert: string;
  innerPlainLen: number;
};

/** The decoys the generator writes, reproduced here so the wac side can rebuild the same layer. */
const CLIENTS = Array.from({ length: 16 }, (_, ci) =>
  Uint8Array.from({ length: 40 }, (_, i) => (ci * 97 + i * 11 + 3) & 0xff));

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const utf8 = (s: string) => new TextEncoder().encode(s);
const be32 = (n: number) => {
  const out = new Uint8Array(4);
  for (let i = 3; i >= 0; i--) out[i] = (n >> (8 * (3 - i))) & 0xff;
  return out;
};

// The fixture has to be the shape the tests assume, or they are about nothing. Checked here so a
// bad regeneration names itself rather than surfacing as a confusing wac assertion.
if (!v.descriptor.startsWith("hs-descriptor 3\n")) {
  throw new Error("the fixture is not a v3 descriptor");
}
if (!v.descriptor.includes("\nsignature ")) throw new Error("the fixture has no signature line");
if (v.signedSpanLen <= 0 || v.signedSpanLen >= v.descriptor.length) {
  throw new Error(`signedSpanLen ${v.signedSpanLen} is not inside a ${v.descriptor.length}-byte document`);
}

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case H_DESCRIPTOR:
      return utf8(v.descriptor);
    case H_CERT:
      return hex(v.cert);
    case H_SUPERENCRYPTED:
      return hex(v.superencrypted);
    case H_SIGN_SEED:
      return hex(v.signSeed);
    case H_SIGN_PUBLIC:
      return hex(v.signPublic);
    case H_BLIND_SEED:
      return hex(v.blindSeed);
    case H_BLIND_PUBLIC:
      return hex(v.blindPublic);
    case H_NUM:
      return be32([v.lifetimeMinutes, v.revision, v.signedSpanLen, v.middleLen,
                   v.innerPlainLen][a[0]]);
    case H_SUBCRED:
      return hex(v.subcredential);
    case H_EPHEMERAL:
      return hex(v.ephemeral);
    case H_SALT:
      return hex(v.salt);
    case H_INNER:
      return hex(v.inner);
    case H_CLIENT:
      return CLIENTS[a[0]];
    case H_CLIENT_COUNT:
      return be32(CLIENTS.length);
    case H_INNER_SALT:
      return hex(v.innerSalt);
    case H_LINK_SPECS:
      return hex(v.linkSpecifiers);
    case H_IP_NTOR:
      return hex(v.ipNtor);
    case H_IP_ENC:
      return hex(v.ipEnc);
    case H_IP_ENC_ED:
      return hex(v.ipEncEd);
    case H_AUTH_CERT:
      return hex(v.authCert);
    case H_ENC_CERT:
      return hex(v.encCert);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/hsdescgen_test.wac", "hsdescgen", [ref]);
