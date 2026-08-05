# 0064 — an Ethereum light client

- **Status:** closed 2026-08-05 by agent-b — the Altair sync protocol passes all four of
  Ethereum's `light_client/sync` cases, nineteen steps. Mainnet config, the fork schedule and a live
  beacon API are split out as 0066.
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b
- **Date:** 2026-08-04
- **Kind:** missing feature
- **Symptom:** not implemented

An Altair light client follows the beacon chain by checking one BLS signature and two Merkle proofs
per update. Almost all of it already exists here; this issue is the bookkeeping that joins it up.

## What is already in the tree

| need | where |
|---|---|
| `FastAggregateVerify` over the participating sync committee | `packages/bls` — **done**, and the operation that scales n× rather than plateauing |
| SHA-256 | `packages/crypto` |
| HTTPS to a beacon API | `packages/tls` (TLS 1.3 in wac; `box gets` already fetches over it) + `packages/http` |
| parsing the response | `packages/json` |
| SSZ `hash_tree_root`, Merkle branches | **done** — `packages/ssz`, 1,093 Ethereum vectors |
| the sync protocol itself | this issue |

**The BLS call is the plain CFRG one.** Verified against
`ethereum/consensus-specs/specs/altair/light-client/sync-protocol.md` rather than assumed — line 455
is `assert bls.FastAggregateVerify(participant_pubkeys, signing_root, ...)`, not
`eth_fast_aggregate_verify`. So the empty-pubkeys-plus-infinity-signature special case does **not**
apply here, and `packages/bls` needs no change. An empty participation set cannot reach the BLS call
anyway: line 383 asserts `sum(sync_committee_bits) >= MIN_SYNC_COMMITTEE_PARTICIPANTS`.

I had flagged this as a possible gap in `packages/bls`. It is not one. Recorded because the opposite
conclusion would have meant a wrong three-line change to a verified package.

## Scope

- `LightClientStore`: finalized header, current and next sync committee, best valid update, optimistic
  header, participation counters.
- `validate_light_client_update`: the slot ordering (`current_slot >= signature_slot >
  attested_slot >= finalized_slot`), the sync committee period rules, the two normalized Merkle
  branches (`FINALIZED_ROOT_GINDEX` = 105, `NEXT_SYNC_COMMITTEE_GINDEX` = 55), then the signature.
- `compute_domain(DOMAIN_SYNC_COMMITTEE, fork_version, genesis_validators_root)` and
  `compute_signing_root` — beacon-chain helpers over SSZ rather than SSZ itself.
- `apply_light_client_update` and the store update rules, including the sync committee period
  transition.
- Fork schedule, enough to pick a `fork_version` from a slot.

## Testing it

The spec tests have a `light_client` suite alongside `ssz_static`, which is the right first oracle
and is fetched the same way as 0063's vectors.

Beyond that, a real one: fetch `/eth/v1/beacon/light_client/updates` from a public beacon API over the
existing TLS client and follow the actual chain. That is the test that a light client works, and it is
also the one that needs a domain on the proxy allowlist — worth asking for only once 0063 and the
offline vectors are done, so the request is for something already known to work.

## Notes

The shape suits wac unusually well: the sync protocol is a state machine over byte arrays with no
ambient I/O, which is what this language is comfortable with, and the two heaviest primitives
underneath it are already written and measured here.

Sequence: 0063's vectors and `packages/ssz` are done. This is next, and nothing external blocks it.

## Resolution — 2026-08-05

`packages/lightclient/src/store.wac`: `LightClientStore`, `initialize_light_client_store`,
`validate_light_client_update`, `apply_light_client_update`, `process_light_client_update`,
`is_better_update` and `process_light_client_store_force_update`, with the sync-committee period
rules. Driven by `test/sync_wac.test.ts` over all four vendored cases — nineteen steps including
three `force_update`s — asserting `finalized_header` and `optimistic_header` after each.

Two things worth recording, both of which cost more effort than the implementation.

**The vectors only test liveness.** Every `process_update` step in them is a valid update, so a
`validateUpdate` returning `true` unconditionally passes all nineteen: the headers being checked come
out of the update, not out of the check. Sixteen faults were planted in the client and each negative
test was confirmed to fail against a broken build before being kept. Ten were caught, three needed
new tests written for them, and three turned out to be unobservable in principle — documented as such
in the source rather than left to look tested.

**One of my own negative tests was testing nothing.** It flipped the last byte of a
`LightClientUpdate` on the assumption that the signature is the trailing field. It is not:
`LightClientUpdate` is entirely fixed-size in Altair and the last eight bytes are `signature_slot`, so
the update was rejected for claiming slot 2^56 and the BLS check never ran. Found by planting
`return true ||` in front of `fastAggregateVerify` and watching the test pass anyway. The offsets are
now asserted against the vector's own `current_slot` so it cannot recur silently.

The `MIN_SYNC_COMMITTEE_PARTICIPANTS` note above held up: `packages/bls` needed no change.
