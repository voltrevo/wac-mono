# 0086 — Merkle-Patricia proofs, so reading a contract does not mean trusting the answer

- **Status:** open
- **Claimed by:** agent-a
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

## The verifier is done; the composition and the endpoint vector are not — agent-a, 2026-08-06

`packages/mpt`. `verify(root, key, nodes) -> Proved { ok, present, value, error }` walks one trie and checks
every step against what its parent committed to. Left open deliberately, because two things this issue asks
for are not done — both named below.

**What is done, and how it is anchored.** A verifier needs proofs, and a generator written beside it agrees
with it for free, so there are three layers:

1. `test/trie.ts` builds a Merkle-Patricia trie in TypeScript, and its roots are checked against **all seven
   cases** in `ethereum/tests`' `trieanyorder.json` (vendored, 1.2 KB, pinned commit). Matching a published
   root is not possible with the hex-prefix encoding, the node shapes, the 32-byte inline rule or the RLP
   beneath them wrong.
2. Proofs from that builder are handed to the wac verifier: every key of every fixture for inclusion, and
   keys chosen to end in each of the three **absence** shapes — an empty branch slot, a diverging extension,
   a leaf whose path is a prefix. `ok` and `present` are separate fields so a broken proof can never read as
   an empty slot.
3. Every perturbation this issue lists, and a few more: a flipped byte at three positions in every node,
   every node dropped in turn, two swapped, a valid node from another position substituted, an unnecessary
   node appended, the proof presented against a different root, and against a root where the value was
   changed. Each must be refused, and each is. Checked from the other side too — deleting the hash check, the
   leftover-node check or the leaf-prefix check each turns tests red.

A fifth test builds the shape a real state trie has: 200 keys that are keccak256 digests, so every path is
64 nibbles and every child is hashed rather than inline, which the small readable fixtures never exercise.

**Not implemented — the composition.** An `eth_getProof` response is *two* walks: the state trie to an
account, then that account's RLP decoded into `[nonce, balance, storageRoot, codeHash]`, then the storage
trie under `storageRoot`. This package verifies one trie against one root. The account structure and the
two-step walk belong above it, with the type that names those fields.

**Not implemented — a real endpoint's proof as a vector.** The anchor here is Ethereum's published *roots*
plus an independently built trie, not a live `eth_getProof`. What that would catch is a misunderstanding of
how a real response is *shaped* — the order nodes arrive in, an account proof and a storage proof together —
rather than of the trie itself, which the seven roots already pin.

## The composition is done too — agent-a, 2026-08-06

`src/account.wac`: `accountAt(stateRoot, address, nodes)` and `storageAt(storageRoot, slot, nodes)`, which is
the two-step walk an `eth_getProof` answer is. The storage root is not a parameter a caller invents — it comes
out of the account proof, and that is the whole point of composing them rather than checking two proofs side
by side.

- an account is `[nonce, balance, storageRoot, codeHash]`, kept as bytes because a balance does not fit an
  `i64`; a four-item check, a 32-byte check on each hash, and a refusal that says which;
- the **address is hashed inside**, because a state trie is a secure trie by definition — and the test for
  that hands over a proof that *fits* the mis-sized key, since the obvious version (a wrong key with somebody
  else's proof) passes with the check deleted, for an unrelated reason;
- a storage value is RLP *inside* the trie's value, so it is unwrapped, and a leading zero, over-32-bytes or a
  list is refused;
- **an absent slot is how Ethereum stores zero** — writing zero deletes the entry — so `present = false` is
  the answer rather than an invented zero;
- and the composition's own failure: account 1 has the empty storage root, and account 2's perfectly valid
  storage proof is refused against it.

Each check was deleted in turn to confirm a test noticed.

**Still open**, for the one thing left: a real endpoint's `eth_getProof` recorded as a vector. The anchor here
is Ethereum's published trie roots plus an independently built trie, which pins the trie itself; what a live
response would additionally catch is a misunderstanding of the response's *shape*.
