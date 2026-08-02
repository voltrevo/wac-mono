# tor

A Tor client, in wac, on top of this repo's TLS 1.3 stack.

It builds circuits. Against a local chutney testnet it does the link handshake, negotiates
link protocol 5, runs ntor, extends to three hops, opens a stream and fetches a consensus
over it — every layer ours, from the TLS 1.3 record up.

It is **not an anonymity tool** and should not be pointed at the real network. It does not
verify consensus signatures (issue 0012), has no flow control (0013), and picks its path
from whatever list it is handed rather than by bandwidth-weighted selection with guards.

## Why this is possible at all

Tor needs Curve25519, SHA-256, HMAC, HKDF, AES-128-CTR, Ed25519 and a TLS client, and all
of those already exist here — the TLS work built them. The only primitive that had to be
added is **SHA-1**, which Tor still specifies for the running digest that authenticates a
circuit's relay cells. Nothing should choose SHA-1 today; a client that wants to talk to
the network implements what the network speaks.

## ntor

`src/ntor.wac`, from tor-spec §5.1.4. A one-and-a-half round trip authenticated key
exchange out of nothing but Curve25519 and HMAC-SHA256.

Two Diffie-Hellmans, and the distinction is the whole design. `EXP(Y,x)` between the two
ephemeral keys gives forward secrecy; `EXP(B,x)` against the relay's published onion key is
what makes the exchange *authenticated*. Drop either and the handshake still completes and
still agrees a key — the first silently loses forward secrecy, the second lets anyone on
the path impersonate the relay — so a round-trip test cannot tell the difference, and the
tests remove each contribution in turn.

A small-order `Y` makes the shared value all zero for every scalar, so an attacker holding
no private key derives the same keys the client does. tor-spec says abort; `ntorClientFinish`
returns an empty array rather than keys plus a boolean, because a boolean invites using the
keys anyway.

## How it is tested

Five tests are relations between the handshake's own outputs, and one is a differential
against **tor's own C implementation** — `test-ntor-cl server1`, built by `tools/tor.sh`.
That last one is the only test that could notice all the others being consistently wrong,
and it checks byte-identical key material rather than mere agreement.

When the binary is missing the suite **fails** rather than skipping. A differential that
silently stops running leaves everything green while checking nothing, which is what
happened to this repo's SHAKE tests until they moved to `node:crypto`.
`TOR_SKIP_INTEROP=1` opts out deliberately.

## The layers, and where each lives

| | |
| --- | --- |
| `src/cell.wac` | cell framing, VERSIONS, NETINFO, CREATE2/CREATED2 |
| `src/ntor.wac` | the handshake |
| `src/relay.wac` | relay cells: the running digest, the onion layers, EXTEND2 |
| `host/link.ts` | the link handshake — owns the socket |
| `host/circuit.ts` | the circuit: layering, extending, streams |
| `host/directory.ts` | parsing a consensus and its microdescriptors |

The split is the same one the TLS package uses: bytes and state machines in wac, and only
the socket in TypeScript. One exception is forced rather than chosen — a `Hop` is a struct
and structs do not cross bindgen, so the hop state crosses as a 290-byte blob and comes back
with every call.

## Relay cells, and the two things that are easy to get wrong

**The digest is a running hash, not a per-cell one.** Each direction has a SHA-1 seeded at
the handshake and updated with every relay cell's payload, digest field zeroed. So a cell
that fails to verify cannot be skipped — its bytes are already in the sender's hash, and
ignoring it desynchronises everything after it. And a cell that turns out not to belong to
a hop must leave that hop's hash untouched, which is why `Sha1` grew a `clone`.

**The keystream is continuous, not per-cell.** A cell payload is 509 bytes, which is not a
multiple of the AES block, so each cell starts part-way into a block the last one began.
`aesCtr` starts from the counter it is given and is therefore the wrong shape entirely;
`CtrStream` in the crypto package is the right one.

## A warning about the relay tests

`test/wac/relay_test.wac` builds the relay side by reading the same key material with the
directions swapped, which makes a genuine round trip. It is a real oracle for the
**Df/Db/Kf/Kb split** and no oracle at all for the cipher and hash underneath, because both
ends run the same code — break either identically at both ends and every test still passes.
Stopping the CTR counter from advancing was tried and that file did not notice.

What catches it is in the crypto package, where a chunked `CtrStream` is compared against
the one-shot that the host's own AES already verifies. If you add a relay test, ask which
of those two kinds it is.

## What is not here

**The real network.** Directory authorities are reached by IP and this sandbox's proxy
allowlist is by domain, so they answer 403; torproject.org is blocked outright. Everything
here is verified offline or against a locally built tor.

**Consensus verification** (issue 0012). The directory parser believes whatever it is
handed. Anyone who can answer a directory request picks your relays and their keys, which
is not a degraded anonymity property but the absence of one.

**Flow control** (issue 0013). No SENDMEs are sent, so a response over about 249KB stops
and the read hangs rather than failing.

**Path selection, guards, and everything about *choosing* a circuit.** A real client weights
by bandwidth, pins a guard so it is not resampling its first hop every circuit, and avoids
putting two relays from one family or one /16 in a path. This takes a list and uses it.

**Streams to arbitrary destinations, verified.** `RELAY_BEGIN` reaches the exit and is
parsed by it — the testnet's exit evaluates our address and answers `RELAY_END`, which
arrives back through the onion layers and decrypts correctly. It has not been seen to carry
data, because chutney's exits reject private addresses and this sandbox has nowhere else to
reach. `RELAY_BEGIN_DIR` is the path that is exercised end to end.
