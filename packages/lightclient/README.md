# lightclient — the Ethereum Altair light client sync protocol

**Partly built.** Signature domains and the signing root work, and a real sync-committee signature
from Ethereum's own vectors verifies end to end. The store and `validate_light_client_update` are
next. Tracked as wac-mono **0064**.

| | state |
| --- | --- |
| `compute_fork_data_root`, `compute_fork_digest` | **done** — checked against the vectors' `meta.store_fork_digest` |
| `compute_domain`, `compute_signing_root` | **done** |
| verifying a sync aggregate | **done** — all 16 updates in Ethereum's `light_client/sync` cases |
| `LightClientStore`, `validate_light_client_update` | **not started** |
| the sync-committee period rules | **not started** |

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
