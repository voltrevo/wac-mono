# 0080 — the probe cannot judge a vote or a consensus yet

- **Status:** closed — the recipe was tor's own test harness
- **Reported by:** agent-b
- **Date:** 2026-08-05
- **Kind:** missing feature
- **Symptom:** not implemented

`packages/tor/tools/parsedesc-probe.c` puts a document through tor's own parser, and design 0002's
step 4 needs that for votes and consensuses next. `router_parse_entry_from_string` and
`authority_cert_parse_from_string` both work with almost no initialisation.
`networkstatus_parse_vote_from_string` does not, and the gap is larger than it looks.

## What was tried

| initialisation | result |
| --- | --- |
| `init_logging` + `crypto_early_init` — enough for the other two parsers | `tor_assert(global_options)` in `get_options_mutable`, `config.c:920` |
| plus `options_new` + `options_init` + `set_options` | segfault, further in |
| plus `subsystems_init` before those | segfault, caught by tor's own handler |

No stack frame resolves to a name in the built library, so which subsystem is missing is not yet
known. Worth expecting a real startup path rather than a handful of calls — tor's own unit tests get
this by linking the test binary against machinery a standalone program does not have.

## Reproduction

Restore the removed mode — the diff is in the history of this file's commit — and:

```
python3 -c "
t = open('.../cached-consensus').read()
..."                                     # any real consensus, e.g. from a chutney net/nodes dir
<probe> consensus < consensus.txt        # segfault
```

## Notes

Two things learned on the way that are worth keeping whatever happens to this:

The probe now installs a **stderr log** (`set_log_severity_config` + `add_stream_log`). Without one,
tor's own diagnosis goes nowhere and an assertion failure aborts with no message at all — which is how
this took three attempts to characterise. With it, a rejected descriptor comes back with tor's reason,
e.g. `[warn] Incorrect ed25519 signature(s)`.

And the network-status verdict will be **weaker than the other two** even once it works.
`networkstatus_parse_vote_from_string` checks structure and digests; verifying a consensus's signatures
is a separate step (`networkstatus_check_consensus_signature`) that needs the authorities'
certificates. For a descriptor or a key certificate the signature check is inside the parse, which is
why ACCEPTED means so much there — see the mutation tables in the commits that added them.

## Resolution

`src/test/testing_common.c` is the answer, and the missing calls were six rather than one.
`init_logging` and `crypto_early_init` are enough for the descriptor and certificate parsers; a network
status also wants `subsystems_init`, `tor_libevent_initialize`, `control_initialize_event_queue`,
`init_protocol_warning_severity_level`, `crypto_global_init` (not merely `crypto_early_init`),
`crypto_seed_rng`, `rep_hist_init`, `bwhist_init`, `initialize_mainloop_events`, and a `DataDirectory`
on the options object before `set_options`.

Then one more thing, which is the interesting one: **`options->TestingTorNetwork = 1`**. Without it a
vote a chutney authority produced is rejected as *"Vote/consensus freshness interval is too short"* —
tor disagreeing with its own configuration rather than with the document, because chutney's voting
interval is seconds and the minimum only relaxes on a test network. A real rejection message, from a
correct document, for a reason that has nothing to do with the document.

## What the verdicts turned out to be worth

The guess recorded above — that a network-status verdict would be weaker than the other two — was half
right, and the half that was wrong matters more:

| document | signature corrupted | body corrupted |
|---|---|---|
| descriptor | REJECTED | REJECTED |
| key certificate | REJECTED | REJECTED |
| vote | REJECTED | REJECTED |
| **consensus** | **ACCEPTED** | **ACCEPTED** |

A **vote** is checked as strictly as a descriptor, because it embeds the authority's key certificate
and can therefore be verified standing alone. A **consensus** is not checked at all in that sense: its
signatures come from other authorities whose certificates arrive separately, so
`networkstatus_parse_vote_from_string` covers structure and digests only. Corrupting a consensus's
signature, or a relay's identity in an `r` line, leaves it ACCEPTED.

So a consensus ACCEPTED means *well-formed*, never *correctly signed*, and any test built on it must say
so. Making it strict needs `networkstatus_check_consensus_signature` with the authorities'
certificates loaded, which is worth doing before the consensus generator is trusted — filed as 0081.
