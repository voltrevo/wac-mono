# ethrpc

Asking an Ethereum node a question, so the packages that *verify* answers have something to verify.

```wac
Answer a = call(cli, "127.0.0.1", 8545, "eth_blockNumber", "[]");
if (a.ok) { core.log(string.fromBytes(stringOf(a.result))); }
```

`example/blocknumber.wac` is that, as a program. Build and run it against a local node:

    deno task app:build packages/ethrpc/example/blocknumber.wac --allow-net -o blocknumber
    ./blocknumber 127.0.0.1 8545

## What a node is trusted for

**Nothing it says.** That is the point of `packages/mpt`, `packages/ens` and `packages/lightclient`: a
node's answer about state is checked against a root, and a node that lies has to produce a trie that
hashes to a root the caller already has.

What it *is* trusted for is availability. It can refuse, stall, or answer about an old block, and nothing
here can tell — those are liveness failures, and no proof rules them out.

**A block hash anchors it, and that is now wired up.** `src/header.wac` re-encodes the header the node
returned and hashes it: a header's hash *is* `keccak256(rlp(header))`, so a block hash from anywhere the
caller trusts — a friend, an explorer, a checkpoint, eventually `packages/lightclient` — turns into a
trusted state root here. `ensowner` takes one as its fifth argument and refuses when it does not match.
Without one, the check is against the node's own `hash` field, which catches a node whose block does not
hash to what it claims and nothing more.

**An anchor selects the block**, rather than being compared against whatever `latest` happens to be. A
caller holding a trusted hash for block N wants the state at N, and on a live chain `latest` moves every
twelve seconds — so the hash is looked up with `eth_getBlockByHash` and the proof is taken at that block's
number. The anchored path answers about the past on purpose.

That needs a node which serves historical proofs. **anvil does not**: it answers `eth_getProof` with the
latest state whatever block is asked for. The proof's root node hashes to the state root by definition, so
that mismatch is caught here and reported as itself — "the node answered with a proof for a different block
than the one anchored to — it may not serve historical proofs" — rather than surfacing as an unreadable
trie failure. geth serves the last 128 blocks by default; an archive node serves all of them.

The header's field list is fork-dependent — `baseFeePerGas` at London, `withdrawalsRoot` at Shanghai, three
more at Cancun, `requestsHash` at Prague — so the encoder appends each optional field **only if the node
reported it** rather than hard-coding a fork. Present-and-zero is not the same as absent: `blobGasUsed: 0x0`
must be encoded as RLP's empty string and a missing one must not be encoded at all, and the two hash
differently.

**Where the root comes from is still the open question for a live chain.** Taking the state root from
the same `eth_getBlockByNumber` that served the proof — which is all a caller can do with this package
today — proves the node is *internally consistent*, not that it is telling the truth: it can invent a whole
state and be believed. `packages/lightclient` is what closes that, by following the chain and handing over
a header nobody has to trust. Until those are wired together, a composition built on this is a proof of
consistency wearing the clothes of a proof of truth, and saying so is cheaper than someone discovering it.

## The whole stack, as a program

`example/ensowner.wac` asks a node who owns an ENS name and believes the answer only because a proof says
so:

    ./ensowner wac.eth 127.0.0.1 8545
    0xd8da6bf26964af9d7eed9e03e53415d37aa96045
    ensowner: proved against a state root this node also supplied — see the README

    the name     packages/ens      namehash, right to left
    the slot     packages/ens      keccak256(node ++ 0), Solidity's mapping layout
    the proofs   packages/ethrpc   eth_getProof, over packages/http and packages/json
    the answer   packages/mpt      the state trie to the registry, its storage trie to the slot

The second line is printed on every run and is not decoration: see the caveat above. A proof that is not
anchored to an independently verified header looks exactly like one that is, and this program is one step
short of that.

`example/ethbalance.wac` is the other half of the same walk: the account rather than what it points at.

    ./ethbalance 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 127.0.0.1 8545
    10000000000000000000000 wei
    nonce 0

Checked against `eth_getBalance` — the number a caller would otherwise have believed — which makes it the
right oracle: the proof has to arrive at exactly that, having got there down the state trie instead. It is
also the only live exercise of the account's own fields; `packages/mpt` proves them against vendored
fixtures and `ensowner` only ever reads a storage slot. An address nothing has touched is **absent from
the trie**, which is a proof that it holds nothing and is not the same as a zero somebody wrote — the
output says which. Balances are printed by long division over the bytes, because 2^256 wei does not fit an
i64 and the low 64 bits would be readable and wrong.

`test/ensowner_live.test.ts` runs it against a real anvil, with the owner slot set through cheatcodes at a
location **`cast` computed** — so a namehash built left-to-right, or a mapping slot hashed `slot ++ key`,
would ask about a slot nothing was written to and print "no owner". A wrong answer that looks like an
answer is exactly what a fixture cannot catch.

## What is here

- `src/rpc.wac` — one call: build the request, POST it, parse the JSON, hand back the `result` node or the
  node's own error message. Batching is not implemented; every call is its own connection.
- `src/getproof.wac` — `proofOfSlots` takes several slots of one account and answers about all of them
  from **one** request, one account proof and one block. `proofOf` is the one-slot spelling. Asking twice
  is not the same thing: on a live chain the second answer is about a state the first never saw, so an ENS
  name transferred in between yields an owner and a resolver that never coexisted. Each answer's `key` is
  checked against the slot asked for at that position, because a node that reordered them would hand a
  caller the resolver where it asked for the owner and both are addresses of the same shape.
- `src/getproof.wac` — `eth_getProof` and `eth_getBlockByNumber`, decoded into the byte arrays
  `packages/mpt` verifies. The only place that knows both shapes: nothing above it has to know `0x` exists.
  Malformed hex is refused rather than guessed at, because a nibble-shifted root verifies against nothing
  and reads as a bad proof.
- The HTTP itself is `packages/http/src/client.wac`, which is `Connection: close` and read-to-EOF. Keep-alive
  would want a connection object with state, and this package does not have one.

## How it is tested

Against **anvil**, a real execution client, over a real socket: `test/rpc_live.test.ts` starts one on a free
port, waits for it to answer rather than sleeping, and runs the built program against it. A refused
connection has to be reported rather than printed as an empty answer.

It skips when anvil is absent and **says so on stderr, with the path it looked in** — a silent skip reads as
coverage. `~/tools/foundry`, not `/tmp`, because /tmp does not survive a container restart and a reference
that vanishes is one the tests stop using without telling anyone.
