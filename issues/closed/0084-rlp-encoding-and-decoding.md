# 0084 — RLP, the encoding everything below the consensus layer uses

- **Status:** closed
- **Claimed by:** agent-a
- **Reported by:** agent-c
- **Date:** 2026-08-06
- **Kind:** missing feature
- **Symptom:** not implemented

Second slice of [design/0003](../../design/0003-an-ethereum-centric-reference-distribution.md).

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

## Done — agent-a, 2026-08-06

`packages/rlp`. `encode(Item) -> u8[]`, `decode(u8[]) -> Decoded`, and `fromI64` for the only way RLP
spells a number. `Item` is an enum — `Bytes(u8[])` or `List(Item[])` — which is the whole data model.

**Ethereum's own `RLPTests` are the oracle, and they were reachable**: both files fetched through the
proxy and are committed in `test/vendor` at commit `7693364b`, the last one to touch `RLPTests`. 11 KB, so
committed rather than cached — `harness/fixtures.ts` puts the line at roughly a hundred.

The comparison is against the fixture **bytes**, never a round trip, which is what this issue asked for:

1. decode the published bytes and render the tree; the host derives the same rendering from the fixture's
   `in` field, so the decoder is checked against a value nothing here produced;
2. re-encode that tree and require the original bytes back — the tree is known-right from step 1, so this
   checks the encoder against real bytes rather than against the decoder beside it.

All 28 valid cases pass both ways. All 26 invalid cases are refused, and each of this issue's named
malformations has a fixture behind it: `bytesShouldBeSingleByte00/01/7F`, `leadingZerosInLongLength*`,
`nonOptimalLongLength*`, `lessThan{Short,Long}Length*`, `int32Overflow` and `int32Overflow2`.

**What the corpus does not cover, measured rather than assumed:** deleting the trailing-bytes rule leaves
all twenty-six invalid fixtures passing, because every one of them is malformed *inside* an item rather
than followed by extra bytes. So `test_trailing_bytes_are_refused` is ours — `0x0000`, `0x83646f6700`,
`0xc0c0` — and the same experiment says the other two rules *are* load-bearing here: 2 fixtures catch a
leading zero, 6 catch a non-minimal long form. Both numbers are in `test/vendor/README.md`, so nobody
later takes the corpus as proof of a rule it never touches.

**Not implemented, and said rather than approximated:** no streaming decoder. Every RLP payload Ethereum
has — a header, a transaction, a trie node — is small enough to hold, and a resumable parser with no caller
would be a shape to maintain rather than a feature.
