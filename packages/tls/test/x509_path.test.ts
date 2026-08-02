// Certificate path building, and the P-384 anchor that made it necessary.
//
// The client used to take the server's first certificate, look for a root that signed it,
// and give up otherwise. That works for a self-signed test fixture and for nothing on the
// public web, where every chain has at least one intermediate. This is the test for what
// replaced it.
//
// ## Why the fixtures are shaped like this
//
//   root    P-384 key, self-signed with SHA-384
//   inter   P-256 key, signed by the root with ecdsa-with-SHA384
//   leaf    P-256 key, signed by the intermediate with ecdsa-with-SHA256
//
// That is github.com's chain in miniature, and it is the shape that showed the gap. The
// leaf and the intermediate are both P-256, so a client with only P-256 parses the whole
// chain happily, builds the path all the way to the top — and then finds the root is on a
// curve it cannot verify, and reports "unknown authority" for a root sitting right there
// in the trust store. Getting to the anchor is not the same as being able to check it.
//
// The hash and the curve also disagree on purpose at the middle link: SHA-384 signed by a
// P-384 key, then SHA-256 signed by a P-256 key. An implementation that reads the curve
// off the signature algorithm rather than off the signer's key passes chains where the
// two happen to line up, which is most of them, and fails a legal one like this.
//
// Time is passed in rather than read, and the fixtures are dated 2020-2045, so none of
// this expires or depends on when it runs.

import { wacBind } from "../../../harness/wacBind.ts";
import { pemBundle, pemToDer, singleRoot } from "../host/connect.ts";

const mod = await wacBind("packages/tls/test/wac/probe.wac");
const x509Parse = mod.x509Parse as (der: Uint8Array) => Uint8Array;
const verifyPath = mod.x509VerifyPath as (
  chain: Uint8Array, chainOffsets: Int32Array, roots: Uint8Array, rootOffsets: Int32Array,
  host: Uint8Array, now: bigint, maxDepth: number) => number;

const data = (n: string) => new URL(`./data/${n}`, import.meta.url);
const readPem = async (n: string) => pemToDer(await Deno.readTextFile(data(n)));
const utf8 = (s: string) => new TextEncoder().encode(s);

const root = await readPem("p384_root.pem");
const inter = await readPem("p384_inter.pem");
const leaf = await readPem("p384_leaf.pem");
const otherCa = await readPem("other_ca.pem");
const imposter = await readPem("p384_imposter.pem");
const leafCrit = await readPem("p384_leaf_crit.pem");
const leafNonCrit = await readPem("p384_leaf_noncrit.pem");
const leafClientAuth = await readPem("p384_leaf_clientauth.pem");
const leafServerAuth = await readPem("p384_leaf_serverauth.pem");
const ncOk = await readPem("p384_nc_ok.pem");
const ncBad = await readPem("p384_nc_bad.pem");
const ncExcl = await readPem("p384_nc_excl.pem");
const ncIp = await readPem("p384_nc_ip.pem");
const ncSuffix = await readPem("p384_nc_suffix.pem");

/** 2030-01-01, comfortably inside every fixture's validity. */
const NOW = 1893456000n;

/** Concatenate DER certificates into a chain blob with its offsets. */
function bundle(...ders: Uint8Array[]): { der: Uint8Array; offsets: Int32Array } {
  const total = ders.reduce((n, d) => n + d.length, 0);
  const der = new Uint8Array(total);
  const offsets = new Int32Array(ders.length * 2);
  let at = 0;
  ders.forEach((d, i) => {
    offsets[2 * i] = at;
    der.set(d, at);
    at += d.length;
    offsets[2 * i + 1] = at;
  });
  return { der, offsets };
}

function check(
  chain: { der: Uint8Array; offsets: Int32Array },
  roots: { der: Uint8Array; offsets: Int32Array },
  host = "wac.test", now = NOW, maxDepth = 8,
): number {
  return verifyPath(chain.der, chain.offsets, roots.der, roots.offsets, utf8(host), now, maxDepth);
}

const KEY_P256 = 2, KEY_P384 = 4;

/** The parse probe packs [notBefore(8)][notAfter(8)][isCa(1)][keyType(1)][sigAlg(1)]. */
const parsed = (der: Uint8Array) => {
  const b = x509Parse(der);
  return { isCa: b[16] === 1, keyType: b[17], sigAlg: b[18] };
};

Deno.test("x509: a P-384 root and a P-256 leaf parse as different key types", () => {
  const r = parsed(root), i = parsed(inter), l = parsed(leaf);
  if (r.keyType !== KEY_P384) throw new Error(`root key type ${r.keyType}, want ${KEY_P384}`);
  if (i.keyType !== KEY_P256) throw new Error(`intermediate key type ${i.keyType}`);
  if (l.keyType !== KEY_P256) throw new Error(`leaf key type ${l.keyType}`);
  if (!r.isCa || !i.isCa) throw new Error("root and intermediate must be CAs");
  if (l.isCa) throw new Error("the leaf must not be a CA");
  // ecdsa-with-SHA384 on the intermediate, ecdsa-with-SHA256 on the leaf.
  if (i.sigAlg !== 3) throw new Error(`intermediate sigAlg ${i.sigAlg}, want 3`);
  if (l.sigAlg !== 2) throw new Error(`leaf sigAlg ${l.sigAlg}, want 2`);
});

Deno.test("x509: a two-deep chain verifies to a P-384 root", () => {
  const code = check(bundle(leaf, inter), singleRoot(root));
  if (code !== 0) throw new Error(`expected success, got ${code}`);
});

Deno.test("x509: the intermediate is genuinely required", () => {
  // Without it there is no way from the leaf to the root, and the answer must be
  // "unknown authority" rather than a success that skipped a link.
  const code = check(bundle(leaf), singleRoot(root));
  if (code !== 5) throw new Error(`expected 5 (unknown authority), got ${code}`);
});

Deno.test("x509: the chain order does not have to be leaf-first-then-upwards", () => {
  // RFC 8446 §4.4.2 says the sender should order the chain, and some do not. The leaf is
  // still required to come first — that much the protocol does pin down — but anything
  // after it is searched by name rather than assumed to be in sequence.
  const code = check(bundle(leaf, otherCa, inter), singleRoot(root));
  if (code !== 0) throw new Error(`expected success with a padded chain, got ${code}`);
});

Deno.test("x509: an untrusted root is refused even though the chain is well formed", () => {
  const code = check(bundle(leaf, inter), singleRoot(otherCa));
  if (code !== 5) throw new Error(`expected 5 (unknown authority), got ${code}`);
});

Deno.test("x509: the right root among several is found", () => {
  // The trust store is 121 certificates in practice, almost all irrelevant to any given
  // chain. Finding the one that matters is the job.
  const store = bundle(otherCa, root, otherCa);
  const code = check(bundle(leaf, inter), store);
  if (code !== 0) throw new Error(`expected success against a multi-root store, got ${code}`);
});

Deno.test("x509: validity is checked at the time given, not the time now", () => {
  const before = check(bundle(leaf, inter), singleRoot(root), "wac.test", 1500000000n); // 2017
  if (before !== 1) throw new Error(`expected 1 (not yet valid), got ${before}`);
  const after = check(bundle(leaf, inter), singleRoot(root), "wac.test", 2500000000n);  // 2049
  if (after !== 2) throw new Error(`expected 2 (expired), got ${after}`);
});

Deno.test("x509: the host name is checked against the leaf", () => {
  if (check(bundle(leaf, inter), singleRoot(root), "sub.wac.test") !== 0) {
    throw new Error("the wildcard should have matched sub.wac.test");
  }
  for (const host of ["wac.test.evil.com", "evil.com", "acwac.test", "a.b.wac.test"]) {
    const code = check(bundle(leaf, inter), singleRoot(root), host);
    if (code !== 7) throw new Error(`expected 7 (name mismatch) for ${host}, got ${code}`);
  }
});

Deno.test("x509: a chain longer than the depth limit is refused", () => {
  const code = check(bundle(leaf, inter), singleRoot(root), "wac.test", NOW, 1);
  if (code !== 9) throw new Error(`expected 9 (depth exceeded), got ${code}`);
});

Deno.test("x509: an empty chain is refused rather than trusted", () => {
  const code = check(bundle(), singleRoot(root));
  if (code !== 8) throw new Error(`expected 8 (empty chain), got ${code}`);
});

Deno.test("x509: a tampered signature anywhere in the chain breaks the path", () => {
  // The last byte of a certificate is the last byte of its signature, so flipping it
  // leaves the DER structure intact and only the cryptography wrong — which is the case
  // that distinguishes verification from parsing.
  for (const [name, which] of [["leaf", 0], ["intermediate", 1]] as const) {
    const parts = [Uint8Array.from(leaf), Uint8Array.from(inter)];
    parts[which][parts[which].length - 1] ^= 1;
    const code = check(bundle(...parts), singleRoot(root));
    if (code === 0) throw new Error(`a chain with a tampered ${name} signature verified`);
  }
});

Deno.test("x509: a trust anchor's own signature is not what makes it trusted", () => {
  // Flipping the last byte of the root breaks its self-signature and changes nothing,
  // because a root is trusted for being in the store rather than for vouching for itself.
  // RFC 5280 §6.1 takes the anchor's name and key as given and starts verifying from the
  // certificate below it. This is asserted rather than left implicit because the opposite
  // looks equally plausible, and an implementation that did check would reject a handful
  // of real roots whose self-signatures use algorithms nobody verifies any more.
  const selfSigBroken = Uint8Array.from(root);
  selfSigBroken[selfSigBroken.length - 1] ^= 1;
  const code = check(bundle(leaf, inter), singleRoot(selfSigBroken));
  if (code !== 0) throw new Error(`expected the path to hold, got ${code}`);
});

Deno.test("x509: a root with the right name and the wrong key is refused", () => {
  // The imposter's subject is byte-identical to the real root's, so every name comparison
  // in the path succeeds and only the signature check can reject it. Two authorities
  // sharing a subject name is not hypothetical, which is why verifyPath keeps searching
  // after a name matches but the signature does not rather than failing outright.
  const code = check(bundle(leaf, inter), singleRoot(imposter));
  if (code !== 5) throw new Error(`expected 5 (unknown authority), got ${code}`);

  // And with both in the store, the real one is still found however they are ordered.
  for (const store of [bundle(imposter, root), bundle(root, imposter)]) {
    const ok = check(bundle(leaf, inter), store);
    if (ok !== 0) throw new Error(`the genuine root was not found past the imposter, got ${ok}`);
  }
});

Deno.test("x509: the system trust store parses without a single certificate taking it down", async () => {
  // 121 roots using algorithms this does not implement, several of which would trap on a
  // strict parse. Unsupported has to be distinct from malformed, or one exotic root in the
  // bundle makes the other 120 unusable — which is exactly what happened before parseCert
  // learned to leave keyType at 0 rather than trap.
  let pem: string;
  try {
    pem = await Deno.readTextFile("/etc/ssl/certs/ca-certificates.crt");
  } catch {
    return; // no system store here; nothing to check
  }
  const store = pemBundle(pem);
  const n = store.offsets.length / 2;
  if (n < 50) throw new Error(`expected a real trust store, found ${n} certificates`);
  const seen = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const der = store.der.subarray(store.offsets[2 * i], store.offsets[2 * i + 1]);
    const t = parsed(der).keyType;   // must not throw for any of them
    seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  // The store is overwhelmingly RSA with a minority of elliptic-curve roots, and the P-384
  // ones are the reason this test file exists.
  if ((seen.get(KEY_P384) ?? 0) === 0) throw new Error("expected at least one P-384 root");
  if ((seen.get(3) ?? 0) === 0) throw new Error("expected RSA roots");
});


// ── The rules that say a well-signed certificate still is not usable ──────────
//
// Everything above establishes that a path exists. These are the checks that say the
// path is not enough — each one accepts a certificate whose signature is perfectly
// valid, and each is a thing an attacker gets to choose if it goes unchecked. The
// fixtures differ from the working chain in exactly one extension apiece.

Deno.test("x509: an unrecognised critical extension makes the leaf unusable", () => {
  // RFC 5280 §4.2: reject rather than ignore. "Critical" is the issuer saying the
  // restriction is load-bearing, so skipping it accepts the certificate on terms nobody
  // checked — and the extension nobody checked could be the one that mattered.
  const code = check(bundle(leafCrit, inter), singleRoot(root));
  if (code !== 12) throw new Error(`expected 12 (unrecognised critical), got ${code}`);
});

Deno.test("x509: the same extension marked non-critical is ignored", () => {
  // The other half of the rule, and the reason it can be applied at all: unrecognised and
  // *not* critical means the issuer is saying it is safe to skip. A verifier that
  // rejected both would reject most of the web.
  const code = check(bundle(leafNonCrit, inter), singleRoot(root));
  if (code !== 0) throw new Error(`expected success, got ${code}`);
});

Deno.test("x509: a certificate issued for client authentication is not a server", () => {
  const code = check(bundle(leafClientAuth, inter), singleRoot(root));
  if (code !== 11) throw new Error(`expected 11 (not for server auth), got ${code}`);
});

Deno.test("x509: extKeyUsage naming serverAuth is accepted, and absent still means yes", () => {
  // Two ways to be allowed, and the second is the one that is easy to get wrong by
  // making the check stricter than RFC 5280: an absent extKeyUsage is unrestricted, so
  // requiring the extension to be present would reject the ordinary leaf.
  if (check(bundle(leafServerAuth, inter), singleRoot(root)) !== 0) {
    throw new Error("an explicit serverAuth leaf was rejected");
  }
  if (check(bundle(leaf, inter), singleRoot(root)) !== 0) {
    throw new Error("a leaf with no extKeyUsage was rejected");
  }
});

Deno.test("x509: a CA constrained to the right namespace still works", () => {
  const code = check(bundle(leaf, ncOk), singleRoot(root));
  if (code !== 0) throw new Error(`expected success under permitted;DNS:wac.test, got ${code}`);
});

Deno.test("x509: a CA constrained elsewhere cannot vouch for this name", () => {
  // The whole point of the extension. This intermediate has the same key and subject as
  // the working one and signed the very same leaf — the only difference is that it was
  // issued with authority over other.test, so its signature over wac.test means nothing.
  const code = check(bundle(leaf, ncBad), singleRoot(root));
  if (code !== 10) throw new Error(`expected 10 (name constraint), got ${code}`);
});

Deno.test("x509: an excluded subtree is excluded", () => {
  const code = check(bundle(leaf, ncExcl), singleRoot(root));
  if (code !== 10) throw new Error(`expected 10 (name constraint), got ${code}`);
});

Deno.test("x509: a constraint on a name form we cannot enforce makes the CA unusable", () => {
  // An IP subtree, which this does not implement. Applying the dNSName part and dropping
  // the rest would be worse than useless: it would report success on a chain whose
  // restrictions were only partly honoured. Skipping the CA leaves no issuer, so the
  // answer is "unknown authority" rather than a name-constraint failure.
  const code = check(bundle(leaf, ncIp), singleRoot(root));
  if (code !== 5) throw new Error(`expected 5 (unknown authority), got ${code}`);
});

Deno.test("x509: dNSName subtrees match on label boundaries, not on suffixes", () => {
  // `wac.test` covers `a.wac.test` and must not cover `evilwac.test`. Comparing by plain
  // suffix is the bug, and it is the one that lets a constrained CA out of its namespace
  // by registering a domain that ends with the right letters.
  //
  // Driven through the real path check rather than a unit test of the matcher. The CA is
  // permitted only `c.test`; the leaf is `wac.test`, which ends with those six characters
  // and is not inside that namespace. A suffix comparison returns success here, so this
  // is the one fixture where a passing result would mean the check is broken.
  const code = check(bundle(leaf, ncSuffix), singleRoot(root), "wac.test");
  if (code !== 10) throw new Error(`expected 10 (name constraint), got ${code}`);

  // And the boundary case that must still be *inside*: a CA permitted `wac.test` covers
  // the leaf, so the rule is rejecting the suffix rather than rejecting everything.
  if (check(bundle(leaf, ncOk), singleRoot(root), "wac.test") !== 0) {
    throw new Error("a name genuinely inside the permitted subtree was rejected");
  }
});
