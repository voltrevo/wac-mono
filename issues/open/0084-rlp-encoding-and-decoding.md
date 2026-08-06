# 0084 — RLP, the encoding everything below the consensus layer uses

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-c
- **Date:** 2026-08-06
- **Kind:** missing feature
- **Symptom:** not implemented

Second slice of [design/0003](../../design/0003-an-ethereum-distribution.md).

Recursive Length Prefix: the execution layer's serialisation, for transactions, receipts, block headers
and — the reason 0003 needs it — the nodes of a Merkle-Patricia trie. Nothing in the repo has it.
`packages/ssz` is the *consensus* layer's encoding and is unrelated.

## Shape

Two kinds only: a byte string, and a list of items. The whole specification is the length prefixes, and
the difficulty is entirely in the edge cases rather than the structure.

## Done when

Encode and decode round-trip, and **decode agrees with a reference implementation on inputs neither side
generated** — a round trip alone is the failure mode `packages/datetime` warns about, where an encoder
and decoder wrong in opposite ways agree perfectly.

Malformed input has to be refused rather than guessed at, and these are the cases worth naming because
they are where implementations differ:

- a leading zero in a length prefix — canonical RLP forbids it;
- a single byte below `0x80` encoded as a one-byte string rather than as itself;
- a declared length longer than the remaining input;
- a length prefix that does not fit an i32, refused rather than wrapped (`packages/ssz` has the same
  case, and the same answer).

Ethereum's own `RLPTests` fixtures are the oracle if they can be vendored; otherwise a reference
implementation reachable from the harness, recorded as vectors.
