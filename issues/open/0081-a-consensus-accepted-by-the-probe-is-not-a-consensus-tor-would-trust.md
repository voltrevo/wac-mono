# 0081 — a consensus ACCEPTED by the probe is not a consensus tor would trust

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b
- **Date:** 2026-08-05
- **Kind:** missing feature
- **Symptom:** not implemented

`packages/tor/tools/parsedesc-probe.c consensus` puts a document through
`networkstatus_parse_vote_from_string`, which checks structure and digests and **not signatures**. A
consensus's signatures are made by other authorities whose certificates arrive separately, so there is
nothing in the parse to check them against.

Measured, by corrupting a real chutney consensus:

| mutation | verdict |
| --- | --- |
| unmodified | ACCEPTED |
| a `directory-signature` corrupted | ACCEPTED |
| a relay's identity in an `r` line altered | ACCEPTED |

The same mutations on a **vote** are rejected, because a vote embeds the authority's key certificate
and can be verified standing alone. The asymmetry is documented at the top of the probe.

## Why it matters before there is a consensus generator

Design 0002 step 4 ends with a C tor client bootstrapping from a consensus we signed. A generator
checked only against this probe could sign with the wrong key, over the wrong span, or not at all, and
still be told ACCEPTED — which is precisely the class of mistake the probe exists to catch, and the
class this repo has hit before.

## What would settle it

`networkstatus_check_consensus_signature(ns, 1)` after the parse, with the authorities' certificates
loaded — `trusted_dirs_load_certs_from_string` over the `cached-certs` a chutney node keeps, or over
the certificate our own authority generates. Then a consensus verdict means what a descriptor's
already does.

Until then, any test that says "tor accepts our consensus" should say "tor finds our consensus
well-formed", and the vote path is the one to lean on for signature correctness.
