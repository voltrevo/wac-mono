# Vendored trie fixtures

`trieanyorder.json` from Ethereum's own `TrieTests` — key/value sets and the root each one produces.
Committed rather than cached: 1.2 KB, and `harness/fixtures.ts` puts that line at roughly a hundred.

- **repository:** `ethereum/tests` (MIT)
- **commit:** `7693364be004b4a00f0efd8c1cba77becf2f87e0`, the last to touch `TrieTests` — a commit rather than
  a branch, because a branch moves and then "where this came from" is a guess.
- **sha256:** `92404d5c2076524e62f02e9657a684aa0561067d49f3b489b78b5033c6fc3e2d`
- **url:** `https://raw.githubusercontent.com/ethereum/tests/<commit>/TrieTests/trieanyorder.json`

Seven cases, 1 to 4 keys each. What they are for is anchoring `../trie.ts`, the TypeScript trie that
generates the proofs the wac verifier is tested against: a builder that matches these roots has the
hex-prefix encoding, the node shapes, the 32-byte inline rule and the RLP under them all right.

## What is deliberately not vendored

**`trietest.json`.** It is the same shape with **deletions** in it — a `null` value removes a key — and
deletion is the hard half of a Patricia trie: a branch that loses its second-to-last child collapses back
into an extension, and getting that wrong changes the root. Nothing here needs it, because a proof is a path
through a trie that already exists, and `test/trie.ts` says so in its own header. Vendoring the file without
implementing deletion would leave a fixture set that looks like coverage and is skipped.

**`hex_encoded_securetrie_test.json`.** Keys pre-hashed, which is the caller's job in this package — `verify`
takes the trie key as bytes and does not care whether somebody hashed it first.
