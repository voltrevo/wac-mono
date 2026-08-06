# mpt

Merkle-Patricia proofs, verified — the piece that turns "a provider told me" into "the state root I already
verified commits to this".

`packages/lightclient` follows the chain and produces a header, so the state root is known. It says nothing
about what is *in* that state. This is where that gap closes.

```wac
import { verify, Proved } from "../mpt/src/proof.wac";

// `key` is the trie key as bytes — for Ethereum's state and storage tries that is a keccak256 digest, which
// the caller hashes, because whether a trie is "secure" is the caller's business and not this walk's.
Proved p = verify(stateRoot, keccak256(address), proofNodes);
if (!p.ok)        { core.warn("the proof does not hold: " + p.error); }
else if (p.present) { use(p.value); }
else                { /* a sound proof that nothing is stored there */ }
```

## Absence is an answer

`ok` and `present` are separate on purpose. A proof of absence — for a storage slot never written, or an
account that does not exist — is a *valid* proof whose path ends before the key does: an empty branch slot,
or a leaf or extension whose own path diverges. It is a different shape from an inclusion proof, and the
half people skip. Conflating "the proof failed" with "there is nothing there" would make a broken proof look
like an empty slot, which is the more dangerous of the two.

## What it refuses

Every step is checked against what the parent committed to:

| perturbation | why it fails |
| --- | --- |
| a flipped byte anywhere | the node no longer hashes to what its parent named |
| a node dropped from the middle | the next hash does not match |
| two nodes swapped | same |
| a valid node from another position | it hashes to something this parent did not name |
| a node the walk never needs | a proof carries exactly its path |
| a proof against another root | the first hash already disagrees |
| not RLP, or RLP of the wrong shape | a node has two items or seventeen |

The tests apply all of those and require each to be refused, which is `packages/ssz`'s standard for
`isValidMerkleBranch` — "verifies every real branch, and rejects every perturbation of one".

## How the proofs in the tests are trustworthy

A verifier needs proofs, and a proof generator written beside the verifier agrees with it for free. So there
are three layers, and the order is the argument:

1. **`test/trie.ts` builds a trie in TypeScript, and its roots are checked against all seven cases in
   `ethereum/tests`' `trieanyorder.json`.** A builder that matches those roots has the hex-prefix encoding,
   the three node shapes, the 32-byte inline rule and the RLP beneath them all right; there is no way to
   match a published root with any of them wrong.
2. **Proofs from that builder are handed to the wac verifier** — every key of every fixture for inclusion,
   and keys chosen to stop in each of the three absence shapes.
3. **Then every perturbation above.**

The builder and the verifier share no code: the builder uses `test/rlp.ts`, twenty lines of its own, and the
verifier uses `packages/rlp`. They share `keccak256` and could not do otherwise, since a trie root *is* a
keccak256 — and that is anchored to three published vectors in `packages/crypto`.

A fifth test builds the shape Ethereum's tries actually have — two hundred keys that are keccak256 digests,
so every path is 64 nibbles and every child is hashed rather than inline — because the readable fixtures are
small tries with short keys and the inline case dominates them.

## The two-step walk

`src/account.wac` is the composition an `eth_getProof` answer actually is:

```wac
AccountProof a = accountAt(stateRoot, address, accountNodes);
if (a.ok && a.present) {
  // The storage root comes *out of the account proof*. A caller that supplies it from anywhere else can be
  // handed a perfectly valid proof of a different account's storage.
  StorageProof s = storageAt(a.account.storageRoot, slot, storageNodes);
}
```

An account is `[nonce, balance, storageRoot, codeHash]`, and its numbers stay as bytes: a balance does not
fit an `i64`, and a caller that wants one has `packages/bignum` and knows what it is asking for. The address
is hashed here rather than by the caller, because a state trie is a secure trie by definition — a mis-sized
or unhashed key is refused rather than turned into a confident wrong answer.

**A slot's value is RLP inside the trie's value**, so `storageAt` unwraps it: a slot holding 1 is stored as
`0x01`, and a value with a leading zero, over 32 bytes, or shaped as a list is refused. **An absent slot is
how Ethereum stores zero** — writing zero deletes the entry — so `present = false` is the answer rather than
an invented zero, and the caller decides what that means in its own terms.

## Not implemented

**A real endpoint's proof, recorded as a vector.** Issue 0086 asks for one and this does not have it: the
anchor here is Ethereum's published *roots* plus an independently built trie, not a live `eth_getProof`. The
difference that would catch is a misunderstanding of how a real response is *shaped* — the order of nodes, an
account proof and a storage proof arriving together — rather than of the trie itself.

**Building or updating a trie.** A verifier needs no writer. `test/trie.ts` builds one, insert-only, and it
is a test oracle rather than part of the package.
