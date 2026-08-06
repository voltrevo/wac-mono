# abi

The contract ABI, in wac: how a call's arguments become calldata and how returned bytes become values.

```wac
import { decode, encode, Decoded, Value, T_UINT, T_BYTES } from "../abi/src/abi.wac";

// `(uint256, bytes)` — the descriptor is data, so a call site describes its types rather than
// hand-writing an accessor per signature.
i32[] schema = i32[](T_UINT(), T_BYTES());
Decoded d = decode(returnData, schema);
if (!d.ok) { core.warn(d.error); }
```

## Heads, tails, and the offset that is relative to the wrong thing

Every static type is a 32-byte word. Every dynamic one — `bytes`, `string`, `T[]`, and any tuple or fixed
array containing one — puts an **offset** in the head and its contents in the tail. Those offsets are
relative to the start of the *enclosing tuple's head*, not to the message, and that is the whole difficulty:
an implementation that measures from the start of the calldata passes every flat case and fails the moment a
dynamic type is nested. Deleting that relativity here fails three of the four tests.
`packages/ssz/src/container.wac` documents the same class of mistake for SSZ's variable fields.

## Schema-driven, because a type is data

A descriptor is an `i32[]` in prefix order: `T_ARRAY, T_STRING` is `string[]`, `T_TUPLE, 2, T_UINT, T_BYTES`
is `(uint256, bytes)`. One walk over the descriptor rather than one function per signature — the shape
`packages/ssz` arrived at for containers, and for the same reason.

## What it refuses

| malformation | why it matters |
| --- | --- |
| an offset past the end of the payload | reading past a field's bounds is how this becomes a security bug |
| an offset pointing back into the head | aims one field at another's bytes, and reads as an ordinary empty value |
| a length longer than what follows it | same |
| a length or offset that does not fit 32 bits | a 256-bit length is not a length |
| calldata that is not a whole number of words | a truncated word is a truncated value |
| a `bool` that is not 0 or 1 | a word with anything else in it is not a bool |
| an `address` with its high twelve bytes set | those bytes are not part of an address |

## How it is tested

`npm:ethers@6` is the oracle. `tools/vendor.ts` encodes a corpus — thirty cases from `uint256` to
`((uint256,bool),(string,bytes))` — and records both the bytes ethers produced and a rendering of the values
*as ethers decodes them*. That corpus is committed, a few kilobytes, so the tests need no network and cannot
silently start passing because a download failed.

Both directions, as `packages/rlp`'s tests do and for the same reason — an encoder and a decoder wrong in
opposite ways agree with each other perfectly:

1. **decode** each case and render it; the rendering must equal ethers';
2. **re-encode** the decoded tree; the bytes must be ethers' exactly.

A third test asserts the corpus still contains the nested cases, because a corpus that quietly lost them
would leave the first two passing and meaning much less.

## Not implemented

**Signed integers, and widths other than 256.** A `uint256` is one word and lands in `Value.Word`
unchanged, which is what every caller in this repo needs. `uint8`…`uint248` are the same word with a range
check nobody has asked for, and sign extension is a decision about a type this package does not have — a
caller that wants a number has `packages/bignum` and the 32 bytes.

**Function selectors are not prepended.** `encode` produces the argument tuple; a call is
`keccak256(signature)[0..4] ++ encode(...)`, and which signature a call has is the caller's business.
