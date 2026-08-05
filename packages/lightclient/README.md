# lightclient — the Ethereum Altair light client sync protocol

**The Altair sync protocol works.** All four of Ethereum's `light_client/sync` cases run
step by step — nineteen steps, sixteen real sync-committee signatures, every Merkle branch — and the
store's `finalized_header` and `optimistic_header` match the vectors' checks after each one. Filed as
wac-mono **0064**, now closed.

| | state |
| --- | --- |
| `compute_fork_data_root`, `compute_fork_digest` | **done** — checked against the vectors' `meta.store_fork_digest` |
| `compute_domain`, `compute_signing_root` | **done** |
| verifying a sync aggregate | **done** — all 16 updates in Ethereum's `light_client/sync` cases |
| `LightClientStore`, `initialize_light_client_store` | **done** |
| `validate_light_client_update` | **done** |
| `apply_light_client_update`, `process_light_client_update` | **done** |
| `is_better_update`, `process_light_client_store_force_update` | **done** |
| the sync-committee period rules | **done** |
| mainnet config, the fork schedule, a live beacon API | **not started** — 0066 |

## What the vectors cannot check, and what stands in for it

Every `process_update` step in Ethereum's sync vectors is a *valid* update: the suite is a liveness
test, and it says nothing about what a client refuses. A `validateUpdate` that returned `true`
unconditionally passes all nineteen steps, because the headers being checked come out of the update
rather than out of the check.

So the negatives are built here by corrupting real data, one field at a time, and each one was
confirmed to fail against a deliberately broken client before being kept:

| plant | what it would otherwise hide |
| --- | --- |
| a bit in the 96-byte signature | the BLS check |
| the finalized header's `body_root` or `state_root`, or a finality branch node | the finality branch — **the signature does not cover these bytes** |
| a `next_sync_committee` key or a branch node | the committee branch |
| a bootstrap committee key or branch node | the whole root of trust |
| `signature_slot == attested_slot` | the one strict slot relation |
| all 32 participation bits cleared | an empty aggregate verifying vacuously |

Two checks resisted this and are pinned directly instead, because every vector update is signed by
almost the whole committee: `>= 2/3` and `>= 1/3` accept exactly the same set, and a safety threshold
of `max/2` and of zero behave identically. Weakening either is invisible to the vectors. They are the
security boundary of the protocol, so `hasSupermajority` is a named function with its own boundary
test at 21 and 22 of 32.

A third group — the signature-period window, `MIN_SYNC_COMMITTEE_PARTICIPANTS`, and
`attested_slot >= finalized_slot` — cannot be observed from outside at all: each is subsumed by a
cryptographic check further down. `src/store.wac` names them as such rather than leaving a reader to
assume they are tested.

## What one verified signature actually proves

Checking a single update exercises, in order: SSZ field extraction from a `LightClientUpdate`,
merkleization of the beacon header it names, the fork data root, the domain, the signing root, the
sync-committee bit selection, and BLS `FastAggregateVerify` over the participating keys. A fault
anywhere in that chain gives a signature that does not verify, so it is a strong statement about all
of it at once — `packages/bls` and `packages/ssz` included.

All sixteen updates across the four vendored cases verify.

## The domain is the replay protection, and it is tested as such

A sync-committee signature is not over the block header. It is over
`hash_tree_root(SigningData(header_root, domain))`, and the domain mixes in the fork version and the
genesis validators root. The same header signed on another chain, or across a fork boundary, has a
different signing root.

Every positive test uses the right domain, so nothing in them would notice if the domain were ignored.
The negatives are therefore explicit: the same signature must **fail** under mainnet's Altair fork
version instead of minimal's, under a genesis validators root with one bit flipped, and over a
different header root.

`meta.store_fork_digest` in each vector is the first four bytes of exactly this fork data root, which
pins the fork version *and* the `ForkData` merkleization — including that `Version` is four bytes
left-aligned in a 32-byte chunk. Minimal Altair's `0x01000001` reproduces the vectors' `0x15cfa0a7`.

## Which committee signs, and why the test accumulates them

The spec picks `current_sync_committee` or `next_sync_committee` by comparing the update's signature
period with the store's. That rule belongs to the client, which does not exist yet, so the test stands
in for it with the store's actual behaviour: start with the bootstrap's committee and accumulate each
one an update supplies.

That is necessary rather than tidy. Three of the sixteen updates carry an **all-zero**
`next_sync_committee` — their filenames end `_x` — and are signed by a committee an earlier update
supplied. Trying only the bootstrap's and the update's own fails those, which is how this was found.

## Configuration

Minimal, because Ethereum's sync-protocol vectors exist only for it: `SYNC_COMMITTEE_SIZE` is 32
rather than 512, and Altair's fork version is `0x01000001` rather than `0x01000000`. Both mainnet and
minimal versions are exported; `packages/ssz`'s descriptor table takes the committee size as a
parameter for the same reason.
