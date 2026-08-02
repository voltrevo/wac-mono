# 0012 — the tor client believes any consensus it is handed

- **Status:** closed 2026-08-02 by agent-c
- **Reported by:** agent-c
- **Date:** 2026-08-02
- **Kind:** missing feature
- **Symptom:** not implemented

## What is missing

`packages/tor/host/directory.ts` parses a microdescriptor consensus and hands back the
relays in it. It does not check who wrote it.

A real Tor client verifies that a majority of the directory authorities signed the
consensus, against authority identity keys compiled into the client rather than fetched
alongside it. That is the step that makes the directory trustworthy without trusting
whoever served it.

Without it, anyone who can answer a directory request chooses your relays and the keys you
use to talk to them. Since the whole circuit is built from that answer, this is not a
degraded client — it is one with no anonymity property at all against an attacker in that
position.

## Why it is filed rather than fixed

It crosses the line the tracker is for: shipping the tor package as if it were usable while
this is missing would be actively misleading, and the fix is a distinct body of work rather
than something to slip into whichever function is being edited. It needs

- the authority identity keys, and a decision about where a testnet's keys come from given
  that a real client's are hardcoded and chutney generates fresh ones every run;
- signature verification over the document's canonical form, which is not the bytes as
  received — the signatures cover the text up to and including `directory-signature`;
- RSA-1024 with the PKCS#1 v1.5 padding tor uses for authority signatures, and SHA-1 or
  SHA-256 digests depending on the authority.

The last of those is mostly there already: `packages/crypto` has RSA verification and both
digests.

## Meanwhile

The header comment in `directory.ts` says plainly that the module is enough to exercise the
handshake, framing and key derivation and not enough to be a Tor client, and the package
README should keep saying so until this closes.

Note the commit that introduced the parser (024e0ee) refers to this as "issue 0003", which
is wrong — 0003 is wacc's generics. Issue numbers are repo-wide, not per package. Recorded
here rather than corrected there, since that commit is pushed.

## Closed

`src/consensus.wac` does the crypto, `host/verify.ts` the parsing, and `relaysFromVerified`
in `directory.ts` is the entry point that will not hand back relays from a document it did
not accept.

The chain is the three steps the issue asked for: the caller names authorities by identity
fingerprint, a certificate is believed only if its identity key hashes to one of those *and*
its signing key is certified by that identity key, and a signature counts only if it comes
from a signing key certified that way. More than half the named authorities must sign.

Two details worth recording, both of which would have produced a verifier that passed every
positive test:

**Tor's signatures carry no DigestInfo.** The usual PKCS#1 v1.5 signature wraps the hash in
a DER structure naming the algorithm, and `rsaVerifyPkcs1` requires exactly that — which is
what stops Bleichenbacher '06. Tor pads a bare digest and nothing else, so it needed a new
`rsaRecoverPkcs1` that returns the payload for the caller to compare. That function is the
more dangerous of the two and says so in its own comment: the caller must compare the whole
payload against a value of known length, never search within it.

**The signed portion ends mid-line.** The digest covers the document up to and including the
string `directory-signature ` — trailing space and all — with the signatures outside it. The
leading newline in the search is load-bearing; without it the token appearing inside a line
would win, and whoever wrote the document chooses where that is.

Verified against the chutney testnet: four authorities, four good signatures, three needed.
The rejections were tested too, since a verifier that accepts everything also accepts a
genuine consensus — a changed relay nickname, a swapped microdescriptor digest, a corrupted
signature, an empty trust set, an unknown-authority trust set, and a certificate whose
signing key was replaced with another authority's are each refused.

The wac side is tested against node's `privateEncrypt`, which produces Tor's exact signature
shape. Most of those assertions are refusals: every single-bit change to the digest, a
sample of byte flips across the signature, short and over-long signatures, a prefix of the
digest, an all-zero signature, and a signature checked under a different key of the same
size.

Freshness came with it rather than after it: `valid-after` and `valid-until` are checked
against a clock the caller supplies, because a correctly signed consensus from last year is
still a lie about who the relays are, and replaying one is the cheapest attack available to
whoever served it.
