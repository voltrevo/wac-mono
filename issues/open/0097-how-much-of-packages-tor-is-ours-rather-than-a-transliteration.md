# 0097 — how much of `packages/tor` is genuinely ours rather than a transliteration of C tor?

- **Status:** open
- **Reported by:** agent-b
- **Date:** 2026-08-07
- **Kind:** task
- **Symptom:** no error

## What this is

`packages/tor` is written against C tor as its oracle, and a lot of what it knows came from
*reading tor's source* rather than from the specs: orderings, refusals, boundary conditions.
That is deliberate and design 0002's D1 principle depends on it — the spec is incomplete, and
in places wrong, so "what does tor actually do" often has no other answer.

The question nobody has answered is how far that went. Extracting a rule and writing wac from
it is our own work. Writing wac with the C open beside it is a transliteration, and it is a
different thing both in intent and in licence — tor is 3-clause BSD, so a derivative work
carries obligations that a reimplementation from observed behaviour does not.

Nobody has audited this. It needs a file-by-file pass, not a grep.

## What is already established

Verbatim C in this repository: **six lines, in two files**, all quoted as commentary —
`design/0002` quotes the four-line `connection_or_connect` self-refusal, and `routerdesc.wac`
quotes two `crypto_digest_smartlist_prefix` calls to explain what the ed25519 digest covers.
Citation-scale, and fine.

Three spot checks found genuinely different structure:

| | C tor | ours |
| --- | --- | --- |
| ntor | `ntor_handshake_state_t` held across two calls, plus a precomputed `tweakset_t`; 341 lines | stateless pure functions, ephemeral key passed in, no state object; 141 lines |
| consensus signatures | operates on a parsed `networkstatus_t` → `voter->sigs` → `document_signature_t`, nested smartlist iteration, five tally lists | scans the document text with `findFrom`, one `Vec<string> signedBy`, no intermediate model at all |
| relay concurrency | libevent: per-connection `read_event`/`write_event` and callbacks | one `core.waitAny` over an `ids`/`owner`/`source`/`slot` table rebuilt each round |

So the shape of the whole differs. That is reassuring and it is not the audit.

## What the audit has to answer

Per file in `packages/tor/src`, where each behavioural rule came from: the spec, reading C, or
live interop. The three to look at hardest are the ones where the *contribution* is a sequence
or a rule-set lifted from tor's code rather than derived independently:

- `hsintroduce.wac` — the five-step ordering is explicitly `hs_circ_handle_introduce2`'s. The
  file says so in its own header.
- `introrelay.wac` — the three refusals are `hs_intropoint.c`'s.
- `rendrelay.wac` — the rules are `rendmid.c`'s, including which length check is `==` and which
  is `>=`.

In each of those the extracted thing is arguably a fact about the protocol that the spec failed
to state. That is the argument; it should be made explicitly and per rule, not assumed.

## Notes

The going-forward rule is now in `packages/tor/README.md`: consult C only to answer a specific
behavioural question. This issue is about the code that already exists.

Not a security finding and not about anyone else's code — it belongs here rather than in
`~/notes/security/`.
