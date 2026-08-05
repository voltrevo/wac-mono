# 0002 — the whole Tor stack: relays, authorities and onion services, and a network of our own

- **Status:** active
- **Opened:** 2026-08-05
- **Written by:** agent-b, from a decision with the operator

## What we are aiming at

`packages/tor` is a Tor **client**. It builds circuits, verifies consensuses, runs a SOCKS5 proxy, and
does all of it on our own TLS 1.3. Everything it talks *to* is somebody else's C.

The direction is the other half: **be the network, not just a user of it.** Concretely, a testnet we
stand up ourselves in which every process is ours —

- **relays** that accept link handshakes, answer `CREATE2`, extend circuits and carry relay cells;
- **directory authorities** that vote, compute a consensus and sign it;
- **onion services** we can both reach and host, v3;
- **a launcher** that wires N relays, M authorities, a client and a service into one network and takes
  it up and down for a test — our own chutney.

Done means: `deno task test` stands up a Tor network with no C in it, publishes an onion service on
it, fetches a page from that service through a three-hop circuit, and tears it down — and separately,
each of our components works inside a chutney network of real tors.

What it is **not**: a production relay. No traffic accounting, no bandwidth self-measurement, no DoS
defences, no `MetricsPort`, no operator ergonomics. It is not something to run on the public network,
and the client README's *What is not here* already lists why the client alone is not either.

## Why this is reachable

The expensive half is done. Tor's cryptography is Curve25519, SHA-256, HMAC, HKDF, AES-128-CTR,
Ed25519, SHA-1 and SHA3-256, and this repo has all of it, including **signing** — `ed25519Sign`,
`ed25519PublicKey`, `x25519Base` — not merely verification, which is what being a relay needs. There
is a **TLS 1.3 server** in `packages/tls/src/server.wac`, which is the single largest thing a relay
requires and the thing we would otherwise have had to write first.

The client already implements both ends of most conversations from one side: cell framing, ntor,
`CREATE2`/`CREATED2`, `EXTEND2`, relay cell encryption with its running digest, flow control with
authenticated SENDMEs, consensus parsing and signature checking. A relay is largely the *responder* to
messages we already know how to send.

And the oracle exists on this machine: `~/tor-build` holds a built `tor 0.4.7.13` and a chutney
checkout whose `networks/` includes `hs-v3`. We can run a real Tor network locally today.

## Decisions

**D1 — every component is validated by putting it in a network that is otherwise real.** Take a
working chutney network, replace exactly one C tor with ours, and require the network to behave
identically. Not our-client-against-our-relay.

The reason is the failure mode this repo keeps hitting: a round-trip test where both ends run our code
tests only the asymmetry between them. Our relay and our client would agree on a wrong ntor, a wrong
digest, a wrong cell layout — and agree confidently. `packages/tor`'s ntor differential against
`test-ntor-cl` exists for exactly this reason and is the model. One C tor on the other side of the
seam is worth more than any number of our own tests.

**D2 — chutney stays until the end.** "Our own chutney" is the target, not the first step. Chutney
already knows how to generate torrcs, allocate ports, wait for a network to bootstrap and tear it
down; rewriting that first would mean debugging our launcher and our relay at the same time, with
neither trusted. So: drive chutney's networks first, substitute components into them one at a time,
and grow our launcher only once the components it would launch are known good.

The corollary is that our components must be **configurable the way tor is** — read a torrc, use the
DataDirectory layout, publish to the authorities named in the config — because that is what lets
chutney launch them without knowing they are not tor.

**D3 — RSA private-key operations are the one missing primitive.** `packages/crypto` has
`rsaVerifyPkcs1`, `rsaVerifyPss` and `rsaRecoverPkcs1`, and `modPow` underneath them, but no signing.
A relay needs it for its RSA identity crosscert, and an authority needs it to sign a consensus: Tor
still uses RSA-1024 identity keys, and that is not negotiable by us because the other end checks them.

**D4 — everything is in scope; fixtures are staging, not the end state** (operator, 2026-08-05).

This decision was originally the other way round: long-term keys would come from `openssl`/`tor` as
fixtures, on the reasoning that RSA key generation is prime search and X.509 generation is DER, and
neither has anything to do with speaking Tor's protocols. The operator revised it: *"we definitely
aspire to implement everything fully and correctly. Nothing should be excluded because 'it's only a
testnet.'"*

So the reasoning was right about the *cost* and wrong about the *conclusion*. Those pieces are
genuinely separate from the protocol work and they are still ours to write:

  - **X.509 generation.** A relay's TLS link certificate is rotated every few hours; one that cannot
    make its own is permanently somebody else's guest. In scope, and next.
  - **RSA key generation.** Prime search with Miller-Rabin. In scope, so that an identity can be made
    here rather than by `tor-gencert`.

A fixture is still the right way to *start* a piece — it separates "can we speak the protocol" from
"can we make the key" — but it is a scaffold with a removal date, and each one should be named where
it stands so it does not quietly become the design.

**D5 — the order is set by where an independent oracle already exists**, not by the layer diagram.
That puts the onion-service *client* first — it needs no new server code and chutney's `hs-v3` network
can host a real service for us to reach today — ahead of the relay, which is a bigger piece with a
harder setup. See *The order of work*.

**D6 — one package, not four.** Relay, authority and onion service go in `packages/tor` beside the
client, because they share the cell layer, the crypto, the directory parser and the circuit
machinery, and a split would either duplicate those or invent a fifth package to hold them. If the
package becomes unwieldy the split can happen later along a seam we will then actually know.

## The order of work

Each step's *done* is a test that fails today.

**1 — RSA signing.** `rsaSignPkcs1` in `packages/crypto`, with CRT if it is not more trouble than it
saves. Done when RFC 8017's own test vectors pass and a signature we produce verifies under OpenSSL.

**2 — the onion service client.** Fetch and verify a v3 descriptor from the HSDir hashring, run the
introduction and rendezvous handshakes, open a stream to a `.onion`. Needs ed25519 key blinding
(rend-spec-v3 §A.2), SHA3-256 (present), and the `hs-ntor` handshake. Done when we fetch a page from
an onion service hosted by C tor on a chutney `hs-v3` network.

**3 — the relay.** Accept a TLS connection, do the link handshake as responder, answer `CREATE2`,
process `EXTEND2` by opening the next hop, and forward relay cells both ways. Done when a **C tor
client** builds a circuit through our relay inside a chutney network — the D1 direction that matters
most, because it puts their implementation on the far side of every seam.

> The pure parts are done: `src/relaycert.wac` (the four certificates and the CERTS cell),
> `src/relaylink.wac` (the responder's four handshake cells), `src/relaycircuit.wac` (CREATE2,
> CREATED2, EXTEND2, EXTENDED2, and being a hop). `ntorServerRespond` already existed.
>
> What remains is the program that holds the sockets, and the one open question in it is the **TLS
> certificate**. `packages/tls`'s server takes a DER certificate and this package cannot yet make
> one — X.509 generation is a separate piece of work. Per D4 a testnet relay can use an
> openssl-generated certificate as a fixture, which is enough to reach the *done* condition; a relay
> that rotated its own link certificate would need the generator.
>
> The first interop milestone is smaller than the full one and worth naming: a C tor client
> configured with `Bridge <addr> <fingerprint>` will do TLS, the link handshake and a one-hop
> `CREATE2` against our relay without any of it being in a consensus. That exercises every seam
> except `EXTEND2` and needs no directory authority.

**4 — the directory authority.** Publish a descriptor, vote, compute a consensus, sign it. Done when a
C tor client bootstraps from a consensus our authority signed.

**5 — the launcher.** Ours: bring up a mixed network from a description, wait for bootstrap, run
something across it, tear it down. Done when the suite stands up a network with no C in it and a
client fetches through three of our relays.

**6 — the onion service host.** `ESTABLISH_INTRO`, descriptor publication, `RENDEZVOUS`. Done when a C
tor client reaches a service we host.

**7 — the interop matrix.** Each component, in both directions, against C tor. This is not a step so
much as the thing steps 2–6 each contribute a row to, and it is where a regression would show.

## State of play

| step | state |
|---|---|
| 1 — RSA signing | **done** — `rsaSignPkcs1`, `rsaSignRawPkcs1`, byte-identical to node's |
| 2 — onion service client | **done** — `src/hsconnect.wac` fetches a page from a real onion service over our own circuits |
| 3 — relay | **in progress** — certificates, the responder handshake, CREATE2 and EXTEND2 all done and tested. What remains is the program with the sockets in it |
| 4 — directory authority | not started |
| 5 — the launcher | not started |
| 6 — onion service host | not started |
| 7 — the interop matrix | not started |
| — X.509 generation | **in progress** — D4, so a relay can make its own link certificate |
| — RSA key generation | not started — D4, so an identity can be made here rather than by `tor-gencert` |

The client itself is done and its own limitations live in `packages/tor/README.md` — guard algorithm,
circuit padding, isolation by credential and the rest. Those are that package's roadmap and are
deliberately not restated here.

## Open questions

- **The proxy allowlist.** The real network is unreachable from this container: authorities are
  IP-addressed and the allowlist is by domain. Everything above is local, which is fine for all seven
  steps — but it means "works against the real network" is never demonstrated, and that should be said
  rather than assumed.
- **Where the launcher's network description lives.** Chutney uses Python network files; ours could be
  JSON read by a Deno harness, or a wac program. Decide at step 5, when there is something to launch.
