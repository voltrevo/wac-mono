# 0085 — ABI encoding and decoding, so a contract call can be made and its answer read

- **Status:** closed
- **Claimed by:** agent-a
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

## Done — agent-a, 2026-08-06

`packages/abi`. Schema-driven, as this issue asked: a descriptor is an `i32[]` in prefix order and one walk
serves every signature, which is `packages/ssz`'s shape for containers.

**`npm:ethers@6` is the oracle**, and it is reachable from this container. `tools/vendor.ts` encodes thirty
cases and records both the bytes ethers produced *and* a rendering of the values as ethers decodes them; the
corpus is committed, so the suite needs no network and cannot start passing because a download failed. Both
directions are checked, because an encoder and a decoder wrong in opposite ways agree perfectly:

- every case decodes to what ethers says it means, and
- re-encodes to the bytes ethers produced, byte for byte.

The nested cases this issue names are all in it — `(bytes, string[])`, `uint256[][]`,
`(uint256,string)[]`, `((uint256,bool),(string,bytes))`, fixed arrays of dynamic elements — and a third test
asserts they are still there, because a corpus that quietly lost them would leave the first two passing and
meaning much less. Measured: making offsets relative to the *message* rather than to the enclosing tuple —
the mistake this issue predicts — fails three of the four tests.

**Refusals**, each with a sentence naming the rule: an offset past the end, an offset pointing back into the
head (which aims one field at another's bytes and reads as an ordinary empty value), a length past the end,
a length or offset that does not fit 32 bits, calldata that is not a whole number of words, a `bool` that is
not 0 or 1, an `address` with its high twelve bytes set. Each was checked by deleting it.

One of them is honest bookkeeping rather than a further refusal: the array-length bound. Deleting it leaves
the suite green, because an element read past the payload fails on its own bounds check — what it buys is a
message that says *which* rule was broken. The source says so at the line.

**Not implemented, and said rather than approximated:** signed integers and widths other than 256 (a
`uint256` is one word and lands in `Value.Word`; sign extension is a decision about a type this package does
not have), and function selectors are not prepended — `encode` produces the argument tuple, and a call is
`keccak256(signature)[0..4] ++ encode(...)`.
