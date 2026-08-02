# tor

A Tor client, in wac, on top of this repo's TLS 1.3 stack.

It builds circuits. Against a local chutney testnet it does the link handshake, negotiates
link protocol 5, runs ntor, extends to three hops, opens a stream and fetches a consensus
over it — every layer ours, from the TLS 1.3 record up.

The consensus is verified before any of that happens: a majority of the directory
authorities must have signed it, checked against identity fingerprints the caller supplies
out of band, and it must be inside its validity window.

Flow control works, including authenticated SENDMEs: 1.2MB over 209 streams on one circuit,
2.5x the circuit window.

It bootstraps over Tor: a one-hop circuit to a starting relay fetches the consensus,
certificates and microdescriptors, verifies them, and every circuit after that is chosen
from what it learnt — bandwidth-weighted per position, distinct /16s, mutual families
excluded, an exit whose policy carries the port, through a pinned guard set.

It should still not be pointed at the real network — see *What is not here*.

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
| `src/consensus.wac` | the signature crypto behind believing a directory |
| `host/directory.ts` | parsing a consensus and its microdescriptors |
| `host/verify.ts` | the authority chain and the majority rule |
| `src/pathsel.wac` | the weighting and the path constraints |
| `host/path.ts` | resolving the consensus into candidates, and guards |
| `host/dirclient.ts` | fetching the directory over Tor, bootstrapping, and refresh |
| `host/pool.ts` | keeping circuits, and deciding which one a stream goes on |

The split is the same one the TLS package uses: bytes and state machines in wac, and only
the socket in TypeScript. One exception is forced rather than chosen — a `Hop` is a struct
and structs do not cross bindgen, so the hop state crosses as a 290-byte blob and comes back
with every call.

## Believing the directory

`parseConsensus` reads a document; `relaysFromVerified` decides whether to believe one. Use
the second. The chain:

```
authority identity fingerprint   supplied by the caller, out of band
  -> key certificate             identity key must hash to that fingerprint,
                                 and must itself have signed the signing key
    -> consensus signature       made by a signing key certified that way
      -> majority                more than half the named authorities
        -> freshness             inside valid-after .. valid-until
```

A real client compiles the fingerprints in. This takes them as an argument, which is the
same thing said honestly — a caller that reads them out of the directory it is checking has
verified nothing.

Two details that would each produce a verifier passing every positive test:

**Tor's signatures carry no DigestInfo.** `rsaVerifyPkcs1` requires the DER structure naming
the algorithm, which is what stops Bleichenbacher '06. Tor pads a bare digest and nothing
else, so this uses `rsaRecoverPkcs1` and compares the payload itself — whole, against a
value of known length, never searched within.

**The signed portion ends mid-line**, at `directory-signature ` inclusive of the trailing
space, with the signatures outside it. The leading newline in that search is load-bearing.

## Choosing a path

The part whose failures are silent. A wrong handshake breaks the circuit; a wrong path
selection builds a working circuit with the anonymity quietly removed.

**Weighted by bandwidth, per position.** Uniform selection sounds fair and is not — capacity
is enormously unequal, so it sends most traffic through relays that cannot carry it and lets
an attacker buy influence with relay *count* rather than with bandwidth. But plain bandwidth
is wrong too, because exit capacity is scarce and must not be spent in the middle position.
The consensus publishes a weight per (flag combination, position) pair for exactly this, and
a client that ignores them concentrates its traffic differently from everyone else's, which
is itself distinguishing.

**Distinct /16s and mutual families.** Two relays in one /16 are plausibly one wire. Family
declarations must be mutual — A listing B means nothing unless B lists A — because otherwise
anyone could shrink your candidate set by claiming kinship with relays they do not run.

**A pinned guard.** With a fresh first hop every circuit, an adversary running a fraction of
the network sees your entry *eventually*, with probability approaching one. Pinning turns
that into a single sample. So a guard set that rotates is not a guard set, and in particular
failure must not cause rotation — otherwise blocking someone's guards is how you get chosen
as the replacement. `currentGuard` skips a failed guard, retries it in an hour, and never
samples a new one to replace it.

The chooser takes its randomness as an argument. That is what lets the tests sweep the whole
random space and assert the distribution exactly, instead of sampling it — a statistical
test loose enough never to flake is loose enough to miss a real bias.

## Bootstrapping is not circular

To build a circuit you need relay keys; to get relay keys you need the directory; to fetch
the directory privately you want a circuit. It resolves because the first fetch does not
need to be private. The consensus is a public document every client has, and downloading it
reveals only that you are a Tor user — which connecting to a relay revealed anyway.

What matters is that the download's *source* is irrelevant, and that is what verification
buys. `bootstrap` takes one starting relay (a real client's hardcoded fallback mirror),
fetches over a one-hop circuit, and refuses anything a majority of authorities did not sign.

## Exit policies

Chosen for the port, not just the flag. A microdescriptor's `p` line is a summary like
`accept 80,443` or `reject 25,119`, and getting the polarity backwards sends traffic to
exactly the exits that will refuse it — which looks like a flaky network, since the client
just retries elsewhere.

**A missing `p` line means reject-all**, matching tor. The Exit flag says the authorities saw
the relay exit *something*; the summary says what. Reading a missing summary generously would
send streams to relays that refuse them.

## Circuits are reused, and retired

Reuse saves three handshakes. That is not why it needs care — "reuse the circuit" and "keep
the circuit forever" are one step apart, and the second is a real leak: everything on one
circuit shares an exit, and the exit sees every destination. A circuit that lives all day
hands one relay the whole day's activity, linked as one person's.

So a circuit stops accepting *new* streams ten minutes after its first one (tor's
MaxCircuitDirtiness). A download already running keeps its circuit; what stops is anything
else joining it.

**Isolation is the caller's call.** Two streams that must not be linked must not share a
circuit, and only the application knows which those are — tor's own default isolates by
client address and SOCKS credentials but deliberately *not* by destination, because a
circuit per site would build faster than the network absorbs. Tor Browser layers
first-party-domain isolation on top. `CircuitPool` guarantees two isolation keys never share
and does not invent one.

## Keeping the directory current

`Directory` refreshes at a random time between `fresh-until` and three quarters of the way to
`valid-until`. Random because every client refreshing at one instant is both a herd on the
caches and a fingerprint; three quarters because the last quarter is slack for a failed
download to be retried before anything expires.

A failed refresh keeps the old consensus rather than falling back to anything unverified —
an attacker who can break your directory fetches should get a client on stale but genuine
data, not one that believes the next thing it is handed. Past `valid-until` with no
replacement, `chooser()` throws rather than building paths from a retired document.

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

**Concurrent read and write past the send window.** `#spend` throws rather than blocking if
the send window empties while a cell is waiting to be read, since draining the read side
mid-write would reorder what the caller sees. A client that uploads more than 1000 cells
while reading needs a proper reader loop; one that fetches does not.

**The guard algorithm is still partial.** It has the two properties that matter — no
rotation on failure, and no rotation when every guard fails at once, which is read as the
network being down rather than as three dead relays. Proposal 271 also ages entries out of
the sampled set on a schedule, keeps a confirmed list separate from a primary list, and
bounds how much of the network a client may ever have sampled. Those are not here.

**Circuits are not built ahead of demand.** A real client keeps clean circuits ready so a
stream does not wait three handshakes. Here the first stream after a retirement pays for the
rebuild.

**No padding, and no defence against traffic analysis.** Cell timing and volume are exactly
what the application produced.

**Streams and ports under one isolation key.** The exit is chosen for the port of the stream
that caused the circuit to be built. A caller mixing ports under one key can be handed an
exit that refuses a later one.

**Streams to arbitrary destinations, verified.** `RELAY_BEGIN` reaches the exit and is
parsed by it — the testnet's exit evaluates our address and answers `RELAY_END`, which
arrives back through the onion layers and decrypts correctly. It has not been seen to carry
data, because chutney's exits reject private addresses and this sandbox has nowhere else to
reach. `RELAY_BEGIN_DIR` is the path that is exercised end to end.
