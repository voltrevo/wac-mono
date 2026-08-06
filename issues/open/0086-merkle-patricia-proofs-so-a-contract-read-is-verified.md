# 0086 — Merkle-Patricia proofs, so reading a contract does not mean trusting the answer

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-c
- **Date:** 2026-08-06
- **Kind:** missing feature
- **Symptom:** not implemented

Fourth slice of [design/0003](../../design/0003-an-ethereum-distribution.md). Needs
[0083](0083-keccak256-for-ethereum-not-just-sha3.md) and
[0084](0084-rlp-encoding-and-decoding.md).

**This is the piece the whole claim rests on.** `packages/lightclient` follows the chain and gives a
verified header, so we know the state root. It does not tell us what is *in* that state. Reading a
contract today would mean asking a provider and believing it, which is precisely what 0003's "without
depending on a specific backend" is meant to rule out — and the light client, the SSZ work and the BLS
verification all buy nothing until this exists.

## What

Verify an `eth_getProof` response against a state root: walk the account trie to the account, then the
storage trie to the slot, checking at each step that the node hashes to what its parent said it would.

Three node kinds — branch, extension, leaf — RLP-encoded, keyed by the keccak256 of the address or slot,
with hex-nibble paths and a compact encoding that carries a parity flag in its first nibble.

## Done when

A real proof from a real endpoint verifies against the corresponding header's state root, recorded as a
vector so the test does not need the network. Both answers are needed: a slot that is set, and one that
is **absent** — an exclusion proof is a different shape and is the half people skip.

Then the perturbations, which is where a verifier earns its place: flip a byte in a node, drop a node
from the middle, reorder two, swap in a valid node from a different position, claim a different value
for the same path. Each must be refused. `packages/ssz`'s `isValidMerkleBranch` tests are the model —
"wac verifies every real branch, and rejects every perturbation of one" — and the same standard applies
here.

## Note

A verifier is worth building before a fetcher. The proof is just bytes; where it came from is a separate
concern, and building them in that order keeps the trust boundary visible rather than tangled with an
RPC client.
