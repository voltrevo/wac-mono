# rlp

Recursive Length Prefix — the Ethereum execution layer's serialisation, in wac.

Two kinds of thing exist: a **byte string** and a **list of items**. There are no integers, no maps, no
types and no field names; a number is the shortest big-endian byte string that spells it, and what a list's
members mean is the caller's business. That is the whole data model, and everything else is length
prefixes.

`packages/ssz` is the *consensus* layer's encoding and is unrelated — different layer, different rules,
different failure modes.

```wac
import { decode, encode, fromI64, Decoded, Item } from "../rlp/src/rlp.wac";

u8[] bytes = encode(Item.List(Item[](
  Item.Bytes("dog".toBytes()),
  Item.Bytes(fromI64(1024))
)));                                   // 0xc9 83 646f67 82 0400

Decoded got = decode(bytes);
if (!got.ok) { core.warn(got.error); }
```

## Canonical, not merely parseable

RLP as deployed is a **canonical** encoding: every value has exactly one valid encoding, and a decoder that
accepts a second one is a consensus fault rather than a convenience. Four rules carry that, and `decode`
refuses each violation with a sentence naming it:

| rule | rejected |
| --- | --- |
| a single byte below `0x80` is itself | `0x81 0x00` |
| a length prefix carries no leading zero | `0xb8 0x00` |
| the long form is for lengths above 55 | `0xb8 0x02` where `0x82` would do |
| the declared length is exactly what follows | `0xf8 0x01 0x80`, and a valid item with bytes after it |

A length that does not fit an `i32` is refused rather than wrapped, which is the answer `packages/ssz`
gives to the same question: a four-byte prefix can spell 4 GB, an `i32` cannot hold it, and a wrapped
negative would be read as a short item.

There is no streaming decoder. Everything Ethereum encodes with RLP — a header, a transaction, a trie node
— is small enough to hold, and a resumable parser with no caller would be a shape to maintain rather than
a feature.

## How it is tested

Ethereum's own `RLPTests`, both halves, vendored in `test/vendor` at a pinned commit. The oracle is the
fixture **bytes**, never a round trip: an encoder and a decoder wrong in opposite ways agree with each
other perfectly, which is the failure `packages/datetime`'s README warns about and issue 0084 asked to
avoid. So each of the 28 valid cases is driven in both directions —

1. **decode** the published bytes and render the tree; the host compares that against a rendering it
   derives from the fixture's `in` field, so the decoder is checked against a value nothing here produced;
2. **re-encode** the tree and require the original bytes back — and since step 1 established the tree is
   right, this checks the encoder against real bytes rather than against the decoder beside it.

The 26 invalid cases must all be refused, and a failure names the fixture: "one of twenty-six was accepted"
is a bisect, `wrongSizeList was accepted` is a fix.

**What the corpus does not cover is written down too.** Deleting the trailing-bytes rule leaves all
twenty-six invalid fixtures passing, because every one of them is malformed *inside* an item; the cases for
that rule are ours. Of the other two rules, 2 fixtures catch a leading zero and 6 catch a non-minimal long
form — measured by deleting each check in turn. See `test/vendor/README.md`.
