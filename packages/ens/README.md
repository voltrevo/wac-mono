# ens

The name a person types, turned into the node a contract is asked about.

```wac
import { namehash, resolverCall, addrCall, addressFromWord } from "../ens/src/ens.wac";

u8[] node = namehash("vitalik.eth".toBytes());   // the 32-byte ENS node
u8[] call = resolverCall(node);                  // calldata for the registry
// …make the call however you make calls…
u8[] resolver = addressFromWord(answer);         // 20 bytes, or empty if the word is not an address
```

`namehash` is EIP-137's recursion, right to left:

    namehash("")      = 32 zero bytes
    namehash("a.b.c") = keccak256(namehash("b.c") ++ keccak256("a"))

which is what makes a subdomain's node derivable from its parent's without asking anybody — `hashInto` is
that one step, exported for exactly that.

## Normalisation is not implemented

A real client normalises a name before hashing it — ENSIP-15: case folding, Unicode mapping, emoji
sequences, confusable checks — so `namehash("UPPER.eth")` in a wallet means `namehash("upper.eth")`. That is
a Unicode specification with a large data table, and none of it is here. **This hashes the labels it is
given.** For a lowercase ASCII name that is the same answer; for anything else it is the caller's job, and a
caller that skips it computes a node nobody else agrees with.

Said rather than approximated with a `toLowerCase`, which would be right for `UPPER.eth` and wrong for half
of Unicode — and wrong in the worst way, by producing a *plausible* node instead of an error.
`tools/vendor.ts` refuses to put a name in the test corpus unless `ethers` says it is already normalised, so
the tests cannot quietly cover for this.

## What else is here

- **`dnsEncode`** — the wire form ENSIP-10 wildcard resolution passes, so a resolver sees the labels and not
  only the node. `foo.eth` is `03 666f6f 03 657468 00`. A label over 255 bytes traps rather than being
  truncated: a truncated name is a different name.
- **`resolverCall`, `addrCall`, `contenthashCall`** — the calldata for the two-step resolution, which is a
  selector and one word. Making the call is not this package's business; it has no network and no opinion
  about where an endpoint lives.
- **`selector`** for any canonical signature, and **`addressFromWord`**, which refuses a word whose top
  twelve bytes are not zero. Taking the low twenty anyway is how a resolver's wrong answer becomes a payment
  to the wrong place.

## Reading the registry instead of asking it

`src/registry.wac` says *where* a name's record lives, so it can be read from a state proof rather than from
somebody's `eth_call`:

```wac
u8[] slot = resolverSlot(namehash(name));        // records[node].resolver
StorageProof s = storageAt(registry.storageRoot, slot, proofNodes);   // packages/mpt
```

That is the difference between a resolution you can check and one you are told. The registry is

    mapping(bytes32 => Record) records;   // slot 0
    struct Record { address owner; address resolver; uint64 ttl; }

so a node's owner is at `keccak256(node ++ 0)` and its resolver one slot above — an increment across a
256-bit number, not a `+1` on something register-sized. Two of the corpus names were **ground out so their
owner slot ends in `ff` and `ffff`**, because an implementation that only touches the last byte is right 255
times in 256; with the carry removed, four assertions fail.

This is a *layout*, not an interface: it is what the deployed bytecode does, and reading storage couples a
caller to it in a way an `eth_call` does not. That coupling is the price of not trusting the answer, and it
is stated in the source rather than discovered.

**A resolver's own storage is not here.** A resolver is a contract of somebody's choosing — the public one, a
wildcard resolver, one answering offchain through CCIP-read — and it has no layout this package can assume.
Reading `addr(node)` from its storage needs that resolver's layout; reading it by `eth_call` means trusting
the answer. Neither is pretended.

## How it is tested

`npm:ethers@6` computed every expectation: twelve names' namehashes and DNS encodings, seven selectors. The
corpus is committed so the suite needs no network, and regenerating it is `tools/vendor.ts`.

Two properties are checked directly rather than against the corpus, because they are what the recursion
*means*: the empty name is the root, and `namehash("foo.eth")` equals `hashInto(namehash("eth"), keccak256("foo"))`.
Swapping the node and the label hash — the obvious way to get the concatenation wrong — fails both.
