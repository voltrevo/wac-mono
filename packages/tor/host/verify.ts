// Deciding whether to believe a consensus.
//
// The parsing is here and every cryptographic decision is in `src/consensus.wac`. What this
// file must get right is the *shape* of the argument:
//
//   1. the caller names the authorities it trusts, by identity key fingerprint;
//   2. a key certificate is believed only if its identity key hashes to one of those
//      fingerprints and its signing key is certified by that identity key;
//   3. a consensus signature counts only if it comes from a signing key certified that way;
//   4. more than half of the named authorities must have signed;
//   5. the consensus must be current.
//
// Step 5 is not an afterthought. A correctly signed consensus from last year is still a lie
// about who the relays are, and replaying an old one is the cheapest attack available to
// whoever served it — no keys required, just a copy of something that was once genuine.
//
// Step 1 is the whole basis. A real client compiles those fingerprints in, because a
// fingerprint you downloaded says nothing about who you downloaded it from. This takes them
// as an argument, which is the same thing said honestly: a caller that reads them out of
// the directory it is checking has verified nothing at all.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/tor/test/wac/consensus_probe.wac");
const keyFingerprint = mod.keyFingerprint as (der: Uint8Array) => Uint8Array;
const verifyDocumentSignature = mod.verifyDocumentSignature as (
  doc: Uint8Array, sha256Flavour: boolean, signingKeyDer: Uint8Array, sig: Uint8Array,
) => boolean;
const verifyKeyCertification = mod.verifyKeyCertification as (
  cert: Uint8Array, identityKeyDer: Uint8Array, sig: Uint8Array,
) => boolean;
const signedLength = mod.signedLength as (doc: Uint8Array) => number;

const enc = new TextEncoder();
const hex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();

function pemBody(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]*-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export type AuthorityCert = {
  fingerprint: string; // the identity key's, uppercase hex
  identityKey: Uint8Array;
  signingKey: Uint8Array;
  signingKeyDigest: string; // uppercase hex, how a signature names which key it used
};

/**
 * Key certificates from a `cached-certs` file, keeping only those that check out.
 *
 * Two checks, and the second is the one that is tempting to skip. The identity key must
 * hash to a fingerprint the caller trusts — otherwise this is a stranger's certificate. And
 * the signing key must be certified *by that identity key* — otherwise the consensus
 * signature would verify against a signing key anybody could have put in the file.
 */
export function parseCertificates(text: string, trusted: Set<string>): AuthorityCert[] {
  const out: AuthorityCert[] = [];
  const blocks = text.split(/(?=dir-key-certificate-version )/).filter((b) => b.trim() !== "");

  for (const block of blocks) {
    const identityPem = block.match(
      /dir-identity-key\n(-----BEGIN RSA PUBLIC KEY-----[\s\S]*?-----END RSA PUBLIC KEY-----)/,
    );
    const signingPem = block.match(
      /dir-signing-key\n(-----BEGIN RSA PUBLIC KEY-----[\s\S]*?-----END RSA PUBLIC KEY-----)/,
    );
    const certSig = block.match(
      /dir-key-certification\n(-----BEGIN SIGNATURE-----[\s\S]*?-----END SIGNATURE-----)/,
    );
    if (identityPem === null || signingPem === null || certSig === null) continue;

    const identityKey = pemBody(identityPem[1]);
    const fingerprint = hex(keyFingerprint(identityKey));
    if (!trusted.has(fingerprint)) continue;
    if (!verifyKeyCertification(enc.encode(block), identityKey, pemBody(certSig[1]))) continue;

    const signingKey = pemBody(signingPem[1]);
    out.push({
      fingerprint,
      identityKey,
      signingKey,
      signingKeyDigest: hex(keyFingerprint(signingKey)),
    });
  }
  return out;
}

/**
 * A directory timestamp, "YYYY-MM-DD HH:MM:SS", always UTC.
 *
 * Parsed rather than handed to `Date`, which would read it as local time and shift the
 * validity window by the host's offset — silently, and differently on different machines.
 */
function parseUtc(s: string): number | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (m === null) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
}

export type Verdict = {
  ok: boolean;
  /** Fingerprints of authorities whose signature verified. */
  signedBy: string[];
  /** Signatures present that did not verify, or named a key we could not check. */
  rejected: { fingerprint: string; why: string }[];
  needed: number;
  /** Set when the document is correctly signed but outside its validity window. */
  stale?: string;
};

/**
 * Whether a consensus was signed by a majority of the authorities the caller trusts.
 *
 * "Majority of trusted authorities", not "majority of signatures present" — the second is
 * no test at all, since whoever wrote the document also chose how many signatures to attach.
 */
export function verifyConsensus(
  consensus: string, certs: AuthorityCert[], trusted: Set<string>,
  now: number = Math.floor(Date.now() / 1000),
): Verdict {
  const doc = enc.encode(consensus);
  const needed = Math.floor(trusted.size / 2) + 1;
  const signedBy = new Set<string>();
  const rejected: { fingerprint: string; why: string }[] = [];

  if (signedLength(doc) < 0) {
    return { ok: false, signedBy: [], rejected: [{ fingerprint: "", why: "no signatures" }], needed };
  }

  // directory-signature [algorithm] <identity fingerprint> <signing key digest>
  const pattern =
    /^directory-signature (?:(\S+) )?([0-9A-Fa-f]{40}) ([0-9A-Fa-f]{40})\n(-----BEGIN SIGNATURE-----[\s\S]*?-----END SIGNATURE-----)/gm;

  for (const m of consensus.matchAll(pattern)) {
    const [, algorithm, identity, keyDigest, sigPem] = m;
    const fingerprint = identity.toUpperCase();

    if (!trusted.has(fingerprint)) {
      rejected.push({ fingerprint, why: "not an authority we trust" });
      continue;
    }
    // Both must match: the certificate says which identity it belongs to, and the signature
    // says which of that identity's signing keys made it. Matching only the identity would
    // accept a signature made with a key that identity never certified.
    const cert = certs.find((c) =>
      c.fingerprint === fingerprint && c.signingKeyDigest === keyDigest.toUpperCase()
    );
    if (cert === undefined) {
      rejected.push({ fingerprint, why: "no verified certificate for the signing key named" });
      continue;
    }
    // The algorithm token is absent on old signatures, which meant SHA-1.
    const isSha256 = (algorithm ?? "sha1") === "sha256";
    if (algorithm !== undefined && algorithm !== "sha1" && algorithm !== "sha256") {
      rejected.push({ fingerprint, why: `unknown digest algorithm ${algorithm}` });
      continue;
    }
    if (!verifyDocumentSignature(doc, isSha256, cert.signingKey, pemBody(sigPem))) {
      rejected.push({ fingerprint, why: "signature did not verify" });
      continue;
    }
    signedBy.add(fingerprint);
  }

  // Freshness last, so a stale-but-genuine document is distinguishable from a forged one.
  // They are both refused; they mean different things and the caller may want to say which.
  let stale: string | undefined;
  const after = parseUtc(consensus.match(/^valid-after (.+)$/m)?.[1] ?? "");
  const until = parseUtc(consensus.match(/^valid-until (.+)$/m)?.[1] ?? "");
  if (after === null || until === null) {
    stale = "no valid-after/valid-until";
  } else if (now < after) {
    stale = `not valid until ${new Date(after * 1000).toISOString()}`;
  } else if (now > until) {
    stale = `expired at ${new Date(until * 1000).toISOString()}`;
  }

  return {
    ok: signedBy.size >= needed && stale === undefined,
    signedBy: [...signedBy],
    rejected,
    needed,
    stale,
  };
}
