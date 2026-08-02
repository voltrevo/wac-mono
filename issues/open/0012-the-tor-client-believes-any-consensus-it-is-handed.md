# 0012 — the tor client believes any consensus it is handed

- **Status:** open
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
