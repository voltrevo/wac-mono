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

**Where the root comes from is the open question, and it is not solved here.** Taking the state root from
the same `eth_getBlockByNumber` that served the proof — which is all a caller can do with this package
today — proves the node is *internally consistent*, not that it is telling the truth: it can invent a whole
state and be believed. `packages/lightclient` is what closes that, by following the chain and handing over
a header nobody has to trust. Until those are wired together, a composition built on this is a proof of
consistency wearing the clothes of a proof of truth, and saying so is cheaper than someone discovering it.

## What is here

- `src/rpc.wac` — one call: build the request, POST it, parse the JSON, hand back the `result` node or the
  node's own error message. Batching is not implemented; every call is its own connection.
- The HTTP itself is `packages/http/src/client.wac`, which is `Connection: close` and read-to-EOF. Keep-alive
  would want a connection object with state, and this package does not have one.

## How it is tested

Against **anvil**, a real execution client, over a real socket: `test/rpc_live.test.ts` starts one on a free
port, waits for it to answer rather than sleeping, and runs the built program against it. A refused
connection has to be reported rather than printed as an empty answer.

It skips when anvil is absent and **says so on stderr, with the path it looked in** — a silent skip reads as
coverage. `~/tools/foundry`, not `/tmp`, because /tmp does not survive a container restart and a reference
that vanishes is one the tests stop using without telling anyone.
