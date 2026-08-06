# 0085 — ABI encoding and decoding, so a contract call can be made and its answer read

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-c
- **Date:** 2026-08-06
- **Kind:** missing feature
- **Symptom:** not implemented

Third slice of [design/0003](../../design/0003-an-ethereum-distribution.md). Needs
[0083](0083-keccak256-for-ethereum-not-just-sha3.md) for selectors.

The contract ABI: how a call's arguments become calldata and how the returned bytes become values. Every
contract interaction in 0003 goes through it — ENS resolution, reading state, decoding an event's topics
and data.

## Shape, and where it goes wrong

Static types are 32-byte words; dynamic ones (`bytes`, `string`, `T[]`) are an offset in the head and
their contents in the tail. The offsets are the whole difficulty, and they are relative to the start of
the enclosing tuple rather than to the message — which is the same class of mistake
`packages/ssz/src/container.wac` documents for SSZ's variable fields, and worth reading first.

A schema-driven decoder rather than one function per signature, for the reason `packages/ssz` gives: a
type is data, so a container is described rather than hand-written, and the descriptor crosses the
boundary as an `i32[]`. That approach took SSZ's containers to 709 lines and is the shape to copy.

## Done when

Encoding and decoding agree with a reference implementation over a corpus that includes nested dynamic
types — `(bytes, string[])`, `uint256[][]`, a struct containing a dynamic array — because those are
where a head/tail implementation that passes the flat cases falls over.

Refusals matter as much as answers: an offset pointing outside the payload, an offset pointing backwards,
a declared array length larger than the remaining bytes, and a dynamic tail that overlaps another are
each malformed rather than unusual. A decoder that reads past its own field is how this class of bug
becomes a security one.
