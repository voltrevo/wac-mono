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

## Two routes, and the cheaper one is probably enough

**Through tor.** `networkstatus_check_consensus_signature(ns, 1)` wants more than a loaded certificate:
it calls `get_n_authorities(V3_DIRINFO)` and `trusteddirserver_get_by_v3_auth_digest`, so the signing
authority has to be a *configured* DirAuthority, not merely one whose certificate is present. That means
building a `DirAuthority` line for our own authority — fingerprint, address, v3 identity — feeding it
through `parse_dir_authority_line` before `set_options`, and loading the certificate with
`trusted_dirs_load_certs_from_string`. It gives the strongest possible verdict and it is a day's
fiddling.

**Through node, which is what this repo already does three times over.** Recover the signature's
payload with the signing key and compare it to our own digest — exactly how
`authcert_wac.test.ts` pins which key signed what, and how `vote_wac.test.ts` pins the signed span
against a real chutney vote. It needs no tor plumbing at all, and it is arguably a *better* test of our
generator: it says which key signed which bytes, where tor's check says only that some quorum of
recognised authorities signed something.

The span itself is not the risk either way — a consensus and a vote are hashed by the same helper over
the same span, and `vote_wac.test.ts` already pins it against a document a chutney authority signed.

So the sequencing is: use tor's parser for structure, node for the signature, and treat the tor-side
strict check as a later refinement rather than a prerequisite. What must not happen is a test that says
"tor accepts our consensus" and means only that it is well-formed.
