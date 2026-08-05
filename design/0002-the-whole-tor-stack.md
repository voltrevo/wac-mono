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
>
> **What is left is `EXTEND2`, and its obstacle is structural rather than cryptographic.** The cells are
> written and tested; acting on one means holding two connections at once — the client's, and a new one
> to the next hop — and `relayd`'s loop blocks on a single `recv` per connection. Concretely a relay
> must, on `EXTEND2`: connect to the named hop, do the link handshake as *initiator* (which is
> `src/link.wac`'s job, written for the client), send `CREATE2` carrying the client's handshake
> untouched, wait for `CREATED2`, answer `EXTENDED2`, and thereafter carry cells both ways.
>
> The multiplexing is already solved, and by a purpose-built primitive rather than anything clever:
>
>     i32 which = core.waitAny(i32[](fromClient.id, fromNextHop.id), -1);
>
> **`Core.waitAny(ids, millis)`** parks until one of the tickets has an answer and returns *which* — its
> index in the list, or -1 if the deadline passed. `-1` millis waits as long as it takes, `0` asks what
> is ready right now. The ids may come from different `Pending<T>` types, so a `recv` and an `accept`
> can be waited on together, and the deadline belongs to the wait rather than to each capability, which
> is why there is no `recvWithin`.
>
> There is prior art for exactly this shape and it should be read first:
> **`packages/box/src/applets/nc.wac`** is a two-source relay whose header says it "could not be written
> until `waitAny` existed", plus `packages/platform/example/{whichever,inetd,pipe,patience}.wac`.
>
> An earlier version of this note recommended polling `Pending.isDone()` with `sleepMillis` instead.
> That is wrong and `waitAny`'s own documentation says so — "polling `isDone` in a loop is a spin, which
> burns a core to avoid parking" — as does `sleepMillis`, which points at `waitAny` for a deadline. The
> correction is recorded rather than quietly removed because the wrong version was pushed, and because
> the mistake was not reading far enough in a file that answered the question directly.
>
> Three relays are what step 5 needs, so `EXTEND2` is its prerequisite as much as this step's
> completion.
>
> **`EXTEND2` is implemented, and provoking one needs `RELAY_BEGIN_DIR` first.** With two of our relays
> in a consensus our authority served, a C tor built a one-hop circuit to the first and sent **relay
> command 13, `BEGIN_DIR`** — it tunnels its directory fetches through a circuit rather than extending,
> and only builds multi-hop circuits once it has bootstrapped. Our relay answers `BEGIN_DIR` with an
> END, so bootstrap stalls at 50 % and the second relay is never contacted. So the order is:
> `BEGIN_DIR` (a directory stream over a circuit, answered from the same documents `dirserve.wac`
> already routes), then multi-hop circuits follow on their own.
>
> Until then `EXTEND2` can only be exercised by our own client, which extends explicitly — worth doing
> as a smoke test, and not a substitute for the C tor path under D1.
>
> **`BEGIN_DIR` is answered now** and it works: relay A served a 2193-byte consensus in 5 relay cells
> over a circuit, from the same `dirserve.wac` routing the DirPort uses. Bootstrap still stops at 50 %,
> and the reason has moved on: tor asked for `/tor/status-vote/current/consensus-microdesc` **eleven
> times** against five for the unflavoured one, and we produce only the ns flavour, so it 404s. Next
> is either `UseMicrodescriptors 0` on the client — one line, and it establishes whether the ns path
> completes — or producing the microdesc flavour and the microdescriptors themselves, which is real
> work. Try the config first: it is a measurement, not a fix.
>
> That measurement was taken. With `UseMicrodescriptors 0` bootstrap reaches **45 % (requesting
> descriptors)** before 50 %, so the ns path does get further — and then it asked *relay A* for the
> descriptors over `BEGIN_DIR`, got our 404, and read its ten-byte `Not found` body as server info eight
> times while reporting `0/2` usable descriptors. Serving only the consensus and certificate was the
> wrong scope: `relayd -D <descriptor>` now serves descriptors too. **Unconfirmed** — the four-process
> re-run was cut short by a shell timeout of the author's own making, not by a failure, so whether
> bootstrap passes 50 % is still an open measurement. Re-run it before building anything on top.
>
> **Measured: it does. `Bootstrapped 75 % (enough_dirinfo)`**, with relay A answering **8** directory
> requests over `BEGIN_DIR`. So the directory side is finished as far as a client needs it: consensus,
> certificate and descriptors all reach a C tor, over a circuit, from our own relay.
>
> Two wrong guesses died on the way, both mine and both cheap to avoid next time. The runs that stalled
> at 5 % were not a readiness race — a poll showed all three processes up in **2 seconds**, so the fixed
> 35-second sleep had always been ample. They stalled because I had moved the relays to spare ports
> while their **descriptors still advertised 5555 and 5557**: tor dialled the port the consensus named,
> found nothing, and stopped. A relay's port lives in a signed document, so it cannot be changed by
> changing a command line — regenerate the descriptor or keep the port.
>
> What is left for step 3 is `EXTEND2` firing, and **a third relay was not it.** With three relays in the
> consensus, all three listening on the ports their descriptors advertise, a C tor still stopped at
> `75 % (enough_dirinfo)`: relay A took one connection, answered 6 directory requests and was never
> asked to extend; relays B and C were never contacted at all.
>
> The reason is simpler than a missing feature. **Nothing asked tor for a circuit.** 75 % is the point
> where it has enough directory information and is waiting for a reason to build one, and the probe is
> configured as a relay with no client traffic — `SocksPort` is open but nobody connects to it. tor
> builds a three-hop circuit when a stream needs one.
>
> So the next step is to give it a reason: a request through its SOCKS port
> (`curl --socks5-hostname 127.0.0.1:9250 ...`) to something reachable inside the testnet. That forces a
> circuit, which forces `EXTEND2` at the first hop, which is the thing that has never been exercised.
> Cheap to try and it needs nothing new written.
>
> **Tried, and a request is not enough either.** Three SOCKS requests timed out and no relay was asked
> to extend. tor says why, in its own words:
>
>     no exit nodes. Tor can only build internal paths, such as paths to onion services.
>     Application request when we haven't received a consensus with exits.
>     We need more descriptors: we have 0/3 ... (no exits in consensus, using mid) = 0% of path bw.
>
> Every relay we vote about carries `p reject 1-65535`, so the consensus contains no exit and tor will
> not build a general path at all — it does not build one and fail at the end, it declines to start.
> So `EXTEND2` needs one of:
>
>   - **an exit policy on one relay** (`accept 80,443` on its `p` line). tor would then build a
>     three-hop path and send `EXTEND2`; the stream would fail at our exit, because `relayd` does not
>     implement `RELAY_BEGIN` — but the extend would have happened, which is what is untested. Cheapest,
>     and dishonest in the consensus only in the sense that the exit refuses every stream it is given.
>   - **an onion service**, since "internal paths" are exactly what tor will still build. That is step 6,
>     and it would exercise `EXTEND2` on the way.
>
> The second is the honest one and the first is the measurement. Note also `0/3 descriptors` in that
> run where earlier two-relay runs fetched them — worth checking whether three descriptors in one
> response exceeds something, before reading too much into the exit message.
>
> **That thread was the real blocker, and the answer was a flag.** The descriptors were never the
> problem: tor logged `router_load_routers_from_string(): 3 elements to add`, accepting all three, and
> then `We know of 0 in the USABLE_FILTERED set` and `0 eligible guards`. **A guard must be a directory
> cache**, so dropping `V2Dir` — correct when we served nothing over `BEGIN_DIR` — left tor unable to
> sample an entry guard and therefore unable to build any path, however many relays it knew. Restoring
> it (truthfully now, since `relayd -C -K -D` answers `BEGIN_DIR`) took bootstrap from 75 % to **95 %**,
> a relay logged `extending to 127.0.0.1:5559`, and relay C accepted a connection and negotiated link
> protocol 5 — a relay-to-relay connection, which only an `EXTEND2` produces.
>
> **Settled: the extend starts and does not complete, and the failure is ours-to-ours.** Per relay, on a
> clean run at 95 % bootstrap:
>
>     relay A (5555)  1 extending to, 0 extended circuit, 1 CREATE2 circuit
>     relay B (5557)  0 extending,    1 CREATE2 circuit
>     relay C (5559)  1 CREATE_FAST circuit
>
> and relay A says why:
>
>     relayd:   extending to 127.0.0.1:5559
>     relayd:   the link handshake with 127.0.0.1 failed
>
> So a C tor's `EXTEND2` is parsed, the hop is dialled, and `linkHandshake` — `src/link.wac`'s
> *initiator* half, written for the client — fails against our own `relayd` responder.
>
> That asymmetry is the interesting part and narrows the bug sharply. **Each half works against C tor**:
> our client builds circuits through real relays, and our relay is accepted by a real tor, which
> negotiates link protocol 5 with it and builds circuits. It is only our initiator against our responder
> that fails, which is exactly the seam D1 warns about — two halves that were each validated against C
> tor, never against each other, and so free to disagree about something C tor is lenient over. Prime
> suspects: what `linkHandshake` requires of the CERTS cell that `relayHandshakeReply` does not send
> (an AUTH_CHALLENGE response, or a certificate type it insists on), and whether the responder's
> NETINFO satisfies the initiator's check.
>
> Narrowed further by reading, with two suspects eliminated:
>
>   - **Not TLS.** `extendCircuit` checks `next.dead` after `handshakeTls` and before `linkHandshake`,
>     and it got past that, so our TLS client and our TLS server do complete a handshake.
>   - **Not the version.** `relaylink.wac` offers `(4, 5)` and `link.wac` offers `(3, 4, 5)`, so they
>     negotiate 5, comfortably past the initiator's `< 4` rejection.
>
> That leaves three branches of `linkHandshake`, and one is much likelier: it returns false on **any
> cell command that is not CERTS, AUTH_CHALLENGE, VPADDING or NETINFO**. The suspicious thing is where
> such a byte would come from — **link protocol 3 uses 2-byte circuit ids and 4 and 5 use 4-byte ones**,
> and the VERSIONS cell is always framed the old way while everything after it is framed the new way. An
> initiator that picks the wrong width at that boundary reads CERTS shifted by two bytes and sees a
> nonsense command. That is exactly this symptom, and exactly what C tor could not have surfaced,
> because against C tor only one side of the framing was ever ours.
>
> So: check what `nextCell` assumes about circuit-id width either side of VERSIONS, in `link.wac` and
> `cell.wac`. The other two branches — `certsCount < 0`, and a short read — are cheap to rule out by
> logging the command byte the loop rejects.
>
> The SOCKS requests still time out, which is expected and separate: nothing implements `RELAY_BEGIN`.
>
> One hypothesis tested and **disproved**: that tor asked our relay for the consensus because our vote
> flagged it `V2Dir`, which advertises a directory cache we do not run. Dropping `V2Dir` and `HSDir`
> from the flags changed nothing — tor still sent `Downloading consensus from 127.0.0.1:5555` at the
> relay's ORPort, repeatedly. It treats **any relay it knows** as a directory source, so there is no
> flag to stop asking; the only answer is to answer. The flags are dropped anyway, because claiming a
> capability we do not have is wrong on its own terms.

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
| 3 — relay | **a C tor client builds a circuit through it** — `src/relayd.wac`. EXTEND2 is parsed and refused, so it is a one-hop relay |
| 4 — directory authority | **descriptor and key certificate done** — `src/routerdesc.wac` and `src/authcert.wac` generate both, and C tor's own parsers accept them, rejecting either if a signature, the certificate chain or a single body byte is disturbed. **vote and consensus both build** — `src/vote.wac` and `src/consensus.wac`. C tor accepts the vote *including its signature* (a vote embeds its certificate); for the consensus tor checks structure only, so the signature is verified by node instead — see issue 0081. and **a C tor fetched our consensus over our own dir port, fetched our certificate, and verified our signature** — `A consensus needs 1 good signatures from recognized authorities for us to accept it. This ns one has 1 (wacauth)`, and its `cached-consensus` is byte-identical to ours. It then fetched our router descriptor. and then, with the relay joined to it: a C tor **fetched our consensus, learned our relay from it, connected to that relay's ORPort, completed the v3 link handshake and built a circuit through it** — `Negotiated version 5 with 127.0.0.1:5555 RSA_ID=ED6057…`, `First hop: finished sending CREATE_FAST cell to '$ED6057…~wacrelay'`, `Bootstrapped 50%`. It stops at 50% because one relay cannot make a three-hop circuit; more relays is step 5's business, and `EXTEND2` is step 3's |
| 5 — the launcher | not started |
| 6 — onion service host | not started |
| 7 — the interop matrix | not started |
| — X.509 generation | **done** — `packages/tls/src/derwrite.wac` and `src/x509gen.wac`, verified by OpenSSL |
| — RSA key generation | **done** — `packages/crypto/src/rsagen.wac`, and OpenSSL accepts the keys |

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
