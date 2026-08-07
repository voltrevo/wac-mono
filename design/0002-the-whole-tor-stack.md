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
> **The framing hypothesis is wrong, and reading `cell.wac` says so.** `cellSize` already handles that
> boundary on purpose: it peeks `buf[at + 2]` for `cmdVersions` before assuming a four-byte id, with a
> comment explaining that 7 cannot be confused with a four-byte-id command in that position. And here
> it is safe for a stronger reason — CERTS, AUTH_CHALLENGE and NETINFO are all **link-level cells with
> circuit id 0**, so `buf[at + 2]` is 0 and never 7. The initiator cannot mis-frame them.
>
> `nextCell` narrows the rest: it loops on `takeCell` and `pump` and returns empty **only when the link
> is dead**, which means a 30-second read timeout or a failed socket. So the two live suspects are:
>
>   - **`certsCount(payload) < 0`** — our client's CERTS parser rejecting the CERTS cell our own relay
>     builds with `certsCell`. Both are ours and neither has ever been shown the other's output, which
>     is the shape of every bug found on this seam so far.
>   - **the link simply going quiet** — relayd waiting for something the initiator will not send, or
>     the reverse, until `READ_TIMEOUT_MS` expires.
>
> They are distinguishable in one run by logging the rejected command byte and whether `l.dead` was set,
> which is the cheapest next step and needs no theory at all.
>
> **`EXTEND2` works. A relay extended a C tor's circuit to the next hop:**
>
>     relayd:   extending to 127.0.0.1:5559
>     relayd:   extended circuit -80345653 to the next hop as -408921639
>
> So the whole path is exercised: a C tor bootstraps from our authority, builds a circuit through one of
> our relays, asks it to extend, and that relay opens a connection to the next, forwards the handshake
> untouched, and answers EXTENDED2. Step 3's last unexercised piece is no longer unexercised.
>
> Two things remain, and the instrumentation named the first by staying silent. One relay still fails,
> and **none** of the three new messages fired for it — so `linkHandshake` returns false in the VERSIONS
> exchange at the top, which was not instrumented. That relay had also been asked to extend to
> `127.0.0.1:5555`, **its own port**: a relay extending to itself is the case to look at, and tor is
> entitled to ask for it. The second is `RELAY_BEGIN`, without which a built path still carries no
> stream.
>
> ### `RELAY_BEGIN` — what it needs, so the next hour is execution
>
> Decided rather than asked: per **D4**, the exit policy becomes true by implementing the stream, not by
> advertising `accept 80,443` on a relay that would refuse every connection. Claiming a capability is
> what the `V2Dir` and `HSDir` episodes were about, in both directions.
>
> The writer already exists — `beginBody(host)` in `relay.wac`, which the client uses. What is missing:
>
>   1. **A parser.** `BEGIN`'s body is `ADDRPORT \0 FLAGS[4]`, where `ADDRPORT` is `host:port` as text,
>      and a leading `:` means "this relay's own address", which is how a rendezvous stream is opened
>      (`hsconnect.wac` sends exactly that). Returns host and port, or refuses.
>   2. **A third source in the `waitAny`.** `relayd`'s loop already parks on the client and the next hop;
>      a stream adds the target socket. That is the same `i32[]` grown by one, and `nc.wac` remains the
>      model.
>   3. **The stream itself.** `connect`, then `RELAY_CONNECTED` carrying the address, then `RELAY_DATA`
>      both ways in 498-byte pieces, then `RELAY_END` with a reason. `chunkRequest` already splits at the
>      right size — it is what `BEGIN_DIR` uses.
>   4. **Flow control.** A directory answer was five cells and never needed a `SENDME`; a real transfer
>      does. `relay.wac` has the SENDME machinery the client uses, so this is wiring rather than new
>      cryptography — but it is the first place a window can actually run out.
>
> Two known holes to close alongside: the relay that fails to extend **to its own port**, where
> `linkHandshake` returns false in the uninstrumented VERSIONS exchange; and `certsCount` versus
> `certsCell`, still never having been shown each other's output.
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

Last checked 2026-08-06. **Three different things get called "done" below and the difference matters**,
so each row says which: *pinned* means pure functions checked against C tor's own vectors or parsers;
*runs* means there is a program; *live* means a C tor was on the other side of it and the thing worked.

| step | state |
|---|---|
| 1 — RSA signing | **pinned.** `rsaSignPkcs1`, `rsaSignRawPkcs1`, byte-identical to node's |
| 2 — onion service client | **live.** `src/hsconnect.wac` fetches a page from a real onion service over our own circuits |
| 3 — the relay | **live, end to end.** A C tor bootstraps from our authority, builds a three-hop circuit through our relays, and **a stream carries bytes**: `stream 5129 open to 192.168.80.2:8087`, 5004 bytes byte-identical to the file served. Link handshake, CREATE2, EXTEND2, BEGIN, CONNECTED, END and DATA **towards the client** all have live witnesses, up to 8 MB with a slow reader. DATA the other way works too, past the 500-cell window, since `relayd` returns SENDMEs (1 MB measured). A connection multiplexes several circuits |
| 4 — the directory authority | **live, both flavours.** Descriptor, key certificate, vote and consensus all accepted by C tor's parsers; the vote's signature verified inside the parse, and the ns **and** microdesc consensuses verified by `networkstatus_check_consensus_signature` — `This microdesc one has 1 (wacauth)`. Microdescriptors are generated, served at `/tor/micro/d/`, fetched by a C tor and accepted; it reaches `Bootstrapped 100% (done)` with `UseMicrodescriptors` at its default |
| 5 — the launcher | **runs, and its condition is met.** `src/network.wac` brings a network up from a description, waits for each node's own ready line, runs work across it and tears it down. A network with **no C tor in it** — our authority, our `dird`, three of our relays, our `socks.wac` — fetched a document whose bytes are identical to the one the authority holds. Two limits: it cannot start a C tor (`spawn` takes a worker bundle, by design), and the suite does not stand a Tor network up with it, because a relay's ports are baked into its signed descriptor and two agents' suites would collide |
| 6 — the onion service host | **partly pinned.** ESTABLISH_INTRO, the hs-ntor responder's introduce keys, INTRODUCE2 parsing and RENDEZVOUS1 are done and checked against cells C tor wrote. The hs-ntor responder is complete (introduce **and** rendezvous keys), and the descriptor's **outer document** is pinned against tor's `hs_desc_decode_plaintext`. **The whole descriptor decodes** under tor's `hs_desc_decode_descriptor`, introduction point and both certificates included. **Key blinding is complete in both directions** — the blinded secret a service signs with is byte-identical to tor's, and the generator now walks the whole chain from one identity seed. **Publication works end to end**, on a DirPort and over a BEGIN_DIR stream: `dird` and `relayd` both accept a `POST /tor/hs/3/publish`, check the descriptor the way `desc_decode_plaintext_v3` does, file it under the blinded key from its certificate, and serve it back at `/tor/hs/3/<z>` — replacing what they hold only for a strictly newer revision counter, as `cache_store_v3_as_dir` does. The **descriptor build is a function** now — `buildDescriptor` takes a service's own introduction points, time period and revision — and is checked by both oracles on three variants, not just the committed fixture. The **publication plan is complete**: from a consensus alone, `servicePlan` chooses the two time periods, the shared random value for each, and the directories — reaching exactly the ones a real service uploaded to. The **upload has a transport** (`publishOverCircuit`) and its answers three meanings, and an **INTRODUCE2 seen twice is dropped**. **Introduction point rotation** follows tor's two drawn limits. **Answering an INTRODUCE2 is done end to end** — `handleIntroduce2` runs tor's sequence from the cell to the RENDEZVOUS1 it sends back. **Not done:** the loop around it, which is circuits — establishing the introduction points, and building the rendezvous circuit this now says to build |
| 7 — the interop matrix | **not started as a document.** Steps 2–6 each contribute rows and most are green; nothing collects them, so a regression in one would not be visible as a regression in *the matrix* |
| — X.509 generation | **pinned.** `packages/tls/src/derwrite.wac` and `src/x509gen.wac`, verified by OpenSSL |
| — RSA key generation | **pinned.** `packages/crypto/src/rsagen.wac`, and OpenSSL accepts the keys |

Known holes that are not steps: a relay extending to *its own* port still fails in the uninstrumented
VERSIONS exchange; `certsCount` and `certsCell` have still never been shown each other's output.

**Flow control was on this list and is not any more** (agent-a, 2026-08-06, from
[#45](https://github.com/voltrevo/wac-mono/issues/45)). It said `SENDME` had never run under a
transfer big enough to exhaust a window, which step 3 above already contradicts — 8 MB to a slow
reader, 1 MB the other way past the 500-cell window, and the client side has carried 1.2 MB over 209
streams at 2.5x the circuit window. A hole that has been filled and left on the list is worse than one
that was never written down: somebody reads it and re-does the work, or trusts the rest of the list
less.

The client's own limitations — guard algorithm, circuit padding, isolation by credential — live in
`packages/tor/README.md` and are deliberately not restated here.

## Open questions

- **The proxy allowlist.** The real network is unreachable from this container: authorities are
  IP-addressed and the allowlist is by domain. Everything above is local, which is fine for all seven
  steps — but it means "works against the real network" is never demonstrated, and that should be said
  rather than assumed.
- **Where the launcher's network description lives.** Chutney uses Python network files; ours could be
  JSON read by a Deno harness, or a wac program. Decide at step 5, when there is something to launch.

## The fetch that proved nothing, and how to test one that does

A C tor with our three relays fetched 49,678 bytes through its SOCKS port, four times, exit 0 — and no
relay logged a stream. The two facts did not join up, so the result was not claimed. The control settles
why: a tor with a fresh `DataDirectory`, no relays and no authority reachable, sitting at
`Bootstrapped 0%`, and `curl --socks5-hostname 127.0.0.1:9260 http://127.0.0.1:8098/` **still returned
49,873 bytes**. curl bypasses a proxy for loopback addresses. That fetch measured curl.

The method that tests something: a **non-loopback** target (`hostname -I`) with the proxy forced —
`curl --noproxy '' --proxy socks5h://127.0.0.1:PORT http://IP:PORT/`. Under the same control that
combination times out, which is what a proxy genuinely in the path looks like.

Re-run properly with all four processes: **the fetch times out and no relay opens a stream.** tor gets
further than it ever has — `90% (ap_handshake_done)` then `95% (circuit_create)` — and then no stream
completes. `no exit nodes` still appears in its log, though those lines may predate the consensus
arriving.

**Next, unverified rather than disproved:** whether that run's consensus actually carried
`p accept 1-65535`. The vector inspected was a stale one from an earlier hour, so this is the first
thing to check — if the policy is present and tor still refuses, the `Exit` flag and the policy
disagree somewhere; if it is absent, the run used a stale `gendesc` build.

The general lesson is worth more than the bug: **a test that cannot fail proves nothing, and a fetch
through a proxy to loopback is one of those.** Run the control first — with the network deliberately
broken — and only trust a success once the failure has been seen.

### The exit policy is right, and the failure moved earlier

Checked first, since the last note left it unverified: the consensus does carry `p accept 1-65535` with
the `Exit` flag, from a freshly built `gendesc`. So the policy was never the problem.

With it in place, and the proxy genuinely in the path, a C tor reaches `95% (circuit_create)` and then:

    each of the three relays   1 circuit created, 0 extends, 0 relay commands, 0 streams

**No relay is asked to extend at all** — where earlier runs, before the exit policy, did produce
`extending to` and one completed `extended circuit`. That is the useful part: the failure moved
*earlier* when the exit appeared. With an exit in the consensus tor stops building the internal paths it
was building before and starts building general three-hop ones, and those die at the first hop instead.

So the question is no longer "does the stream work" but **why a general circuit stops after CREATE**.
One circuit at each relay and no second cell suggests tor creates, dislikes something about the answer,
and abandons rather than extending. Worth looking at next, cheapest first:

  - the `pr` line our vote advertises versus what a general circuit requires (`Relay=`, `FlowCtrl=`),
    since an internal path and a general path need not demand the same subprotocols;
  - whether tor expects a `RELAY_SENDME` or a padding negotiation early on a general circuit that a
    one-hop directory circuit never asked for;
  - tor's own log around `circuit_create` for the reason it drops each attempt, which is the direct
    route and needs no theory at all — the pattern all day has been that the log says it and the
    theories do not.

### `EnforceDistinctSubnets` was the path-selection blocker

`circuitbuild.c:495` closed 235 circuits, with one `Failed to find node for hop` beside it. Every relay
here listens on **127.0.0.1**, and tor will not put two relays from one /16 in a circuit — so no
three-hop path could be *chosen*, whatever the relays could do. Chutney sets `EnforceDistinctSubnets 0`
for the same reason, and the probe's torrc now does too.

With it set, path selection works and the shape of the failure changes again:

    relay A   2 circuits, 1 extending to, 1 extended circuit
    relay B   2 circuits, 1 extending to, 0 extended circuit
    relay C   1 circuit,  0 extends

**The first extend completes and the second does not.** A extends to B and finishes; B extends to C and
does not, which is the ours-to-ours `linkHandshake` failure already recorded above — the one that
returns false somewhere in the VERSIONS exchange that was never instrumented. It is now the single
thing standing between this network and a stream: path selection works, the exit policy is right, the
first hop extends, and the second hop's link handshake is where it stops.

So the next step is not a new experiment but the old bug, now clearly load-bearing: instrument the two
returns at the top of `linkHandshake` — the VERSIONS reply check and `negotiateVersion(...) < 4` — and
run once. Everything else in the chain has been eliminated by measurement.

### The extend failure is at the last line of `linkHandshake`

Instrumented all five early exits — no VERSIONS answer, a first cell that is not VERSIONS, no version in
common, an unexpected cell command, a CERTS cell that will not parse — and ran. **None of them fired**,
while the relay still reported `the link handshake with 127.0.0.1 failed`.

That leaves exactly one exit: `return !l.dead` after `sendCells(l, encodeNetinfo(...))`. So every cell of
the handshake was exchanged successfully and **the link died on the way out**, which is a much smaller
question than "the handshake fails": the responder accepted VERSIONS, sent CERTS, AUTH_CHALLENGE and
NETINFO, the initiator read them all, and then the socket went.

It now says so. Look next at why the responder drops a connection at that moment — `relayd` closing
after its own handshake reply, an idle timeout on the wrong side, or a `send` refused on a socket the
other end has already closed.

Worth noting the shape of this: five instrumented branches staying quiet was more informative than any
of them firing would have been. The uninstrumented path is the one that was taken, and it was the only
one nobody had thought worth a message.

### A relay serves one connection at a time, and that is the structural blocker

The instrumented message never fired, because this run never reached an extend: with the same
configuration that produced two extends an hour earlier — `EnforceDistinctSubnets 0` confirmed present
in both the script and the generated torrc — **each relay took exactly one connection and no relay was
asked to extend.** The runs are not deterministic, and the difference correlates with load (0.39 then,
1.91 now).

`relayd`'s accept loop explains it:

    Socket conn = cli.accept(listener.handle).wait();
    serve(core, cli, conn, id, certs, now, docs, hasDir);
    cli.closeSocket(conn.handle);

**One connection at a time, start to finish.** A relay in a three-hop circuit has to serve the client
*and* accept an incoming extend from another relay at the same time, and a relay busy inside `serve`
never returns to `accept`. Whether a circuit can be built therefore depends on the order connections
happen to arrive — which is exactly the nondeterminism observed, and it explains the earlier "second
extend fails" just as well as a handshake bug does: the far relay was not in `accept` to answer.

This is a bigger change than the instrumentation it displaces: `serve` would have to become one of
several connections the loop multiplexes, with `accept` as another id in the same `waitAny` that
already watches the client, the next hop and the stream. `packages/platform/example/inetd.wac` is the
model — its whole subject is accepting while serving.

The `link died while sending NETINFO` message stays, and is still the thing to read when an extend does
happen. But it is no longer the leading suspect: a socket closed by a relay that went back to `accept`
and never came, and a handshake that genuinely disagrees, look identical from the initiator's side.

### Correction: `inetd.wac` is not the model, and nothing in the repo is

The note above named `packages/platform/example/inetd.wac` as the model for accepting while serving. It
is not, and it says so itself:

> One connection, then exit. A loop would need `accept` and the live child watched together, which
> `waitAny` can do — but serving one is what makes this testable, and **concurrency across connections
> is a different design decision from this one.**

Every `waitAny` user in the repo watches a *fixed* set of handles — `nc.wac` two, `inetd.wac` one
connection's worth. **A relay would be the first program here to multiplex an unbounded set**, which
makes this a design step rather than a copy.

The shape it needs, written down so the next attempt starts from a decision rather than a blank page:

  - **A `Conn` struct** holding what `runLink`'s locals hold today — the TLS state, the cell buffer,
    `versionsSeen`, the circuit id and `Hop`, the next-hop `Link`, the stream socket, and the one
    outstanding `recv` ticket per source.
  - **An array of them**, plus the listener's `accept` ticket, all in one `waitAny`. The index that
    comes back selects a connection *and* which of its sources spoke, so the mapping from index to
    (connection, source) has to be built each time round rather than assumed — that is the part that
    will be fiddly, and the part worth a test of its own.
  - **A cap.** Unbounded means a relay holds every connection anyone opens; tor's own relays have one,
    and a testnet relay with no limit is a program that dies under its first mistake rather than
    refusing politely.

The prize is worth the size: it is the difference between a relay that can be *in* a circuit and one
that can only be at the end of it, and it is the last structural thing between this network and a
stream.

### A relay multiplexes now, and a C tor reaches 100 %

`relayd`'s loop no longer serves one connection to completion. `runLink`'s locals became a `Conn`
struct; the listener's `accept` ticket sits in the same `waitAny` as every live connection's sources;
and the wait list is rebuilt each round with parallel `owner`/`source` arrays, because the index that
comes back has to be translated into *which connection* and *which of its sources* — recording that
mapping rather than inferring it is the whole trick. `MAX_CONNS` bounds it: a relay that accepts
everything offered dies on the first burst, and one refusal is better for the network than that.

The measurement, against the same run an hour earlier:

    before   each relay 1 connection, 0-1 extends, at most 1 completed, Bootstrapped 95%
    after    each relay 2 connections, 2 extends, **2 completed**, **Bootstrapped 100% (done)**

**100 % is new.** A C tor now builds a complete circuit through our relays and calls the network
usable. That is step 3's `EXTEND2` no longer merely working once but working reliably, and it is the
first time the whole directory-and-relay stack has satisfied a real tor end to end.

The fetch still times out with no relay opening a stream, so `RELAY_BEGIN` is the remaining gap between
a usable network and a byte delivered. That is now the only thing left in step 3.

### The descriptor and the vote disagreed about the exit policy

No stream ever reached an exit, and the reason was not the stream code. **The descriptor said
`reject *:*` while the consensus said `accept 1-65535`** — and a client believes the descriptor, so
relays advertised as exits were never chosen as one. The policy was hardcoded in `routerDescriptor`
while the vote's came from `RelayOpinion`; two documents describing one relay, free to disagree.

It is a field now, so they cannot. And fixing it exposed a second distinction worth keeping: **the two
are written in different grammars.** A descriptor's policy takes address patterns (`accept *:*`); a
consensus `p` line takes a port summary (`accept 1-65535`). Putting the summary form in a descriptor is
not merely unidiomatic — `router_parse_entry_from_string` **rejects the whole document**, which is how
the mistake was caught within a minute of making it.

The committed descriptor vector still reproduces byte for byte, because the fixture keeps the policy
that was hardcoded when those bytes were signed.

### The multiplexer span its accept ticket 167,000 times, and I blamed the machine

Instrumenting the forwarding path — silent until now, which made "no stream opened" impossible to tell
from "no cell arrived" — showed cells *are* forwarded to later hops. It also showed something worse in
the relay's own log:

    accept: Another accept task is ongoing        × 167,212

On a `waitAny` timeout the loop was cancelling the accept ticket and issuing a new one. **`cancel`
detaches this program from the answer; it does not stop the host accepting.** So the replacement
collided with the accept still running, failed instantly, settled instantly, woke the wait instantly,
and re-armed — a hot loop burning a core per relay.

Two lessons, and the second is the uncomfortable one:

  - A timeout means *nothing arrived*, not *the ticket is spent*. The accept ticket is now kept across
    timeouts, and an accept that genuinely fails stops the listener once with a message rather than
    retrying thousands of times a second.
  - **I attributed that load to another agent.** Runs at load 4.5 and 6.1 were called invalid "because
    the box is busy" for two hours — and the busy thing was this program. A load average is evidence
    about the machine, not about who caused it, and I read it as though it were both.

Verified: 167,212 spins before, **0** after, with the relays otherwise behaving as before.

### A stream carried bytes end to end

The last thing in this design that had never been shown: a byte arriving through a stream one of our
relays opened. It does now.

    control: direct fetch of 192.168.80.2:8087 gave 5004 bytes
    bootstrapped after 5s
    socks attempt 1 exit 0 bytes 5004
    STREAM_OPEN: A=1
    relayd:   stream 5129 open to 192.168.80.2:8087

and from the C tor on the other side of it:

    'connected' received for circid 4095531604 streamid 5129 after 0 seconds.
    14: end cell (closed normally) for stream 5129. Removing stream.

`curl --proxy socks5h://` through tor 0.4.7.13, over a three-hop circuit built entirely from our
relays, to a non-loopback address — and the 5004 bytes it received are byte-identical to the file the
server holds. Every layer between now has a live witness: link handshake, CREATE2, EXTEND2, BEGIN,
CONNECTED, DATA in both directions, END.

Two bugs stood between here and there, and neither was in the protocol.

**A connection carried one circuit.** `Conn` held `circId`, `hop`, `hasNext`, `hasStream` inline, so a
second CREATE2 on the same connection was answered with DESTROY and a warning saying so. That is not
an exotic case: a bootstrapping tor opens a directory circuit and an exit circuit **to the same guard,
over the same TLS connection, within the same second**. The exit circuit was the one being refused,
which is why the BEGIN never arrived — a client-visible failure that looked, from the relay's own log,
like nothing happening at all. Per-circuit state is a `Circ` now, and a `Conn` holds up to eight; a
circuit id is unique per connection, so the lookup is per `Conn` rather than global.

**`continue` became `c.live = false; return`.** Moving the single-connection loop into `feedConn` for
the multiplexer turned "keep going" into "close the connection" at two sites: after forwarding a
stream's data to the client, and after forwarding the next hop's cells. So the connection died on the
first cell of any response it carried. The refactor compiled, the tests passed, and the circuit still
built — the damage only showed once traffic flowed through it, which is the one thing no test in this
repo does.

### Four runs that proved nothing, and what they were measuring instead

Getting to that result took six runs. Four of them produced a confident-looking answer about the
relays while measuring something else entirely, and the pattern is worth keeping:

| what the run appeared to show | what was actually true |
|---|---|
| the exit refused the connection | port 8086 was still held by the previous run's web server |
| bootstrapped in 1s, then the fetch failed | tor **appends** to its log; the check matched the *previous* run's `Bootstrapped 100%` |
| a 5004-byte fetch with every relay counter at 0 | the previous run's relays were still up under `timeout 420`; the new ones failed to bind and the old ones were logging to deleted inodes |
| the control fetch returned 3083 bytes | **`--noproxy ''` does not bypass a proxy** — that was a Squid error page. `--noproxy '*'` is the form that does |
| four processes never became ready | `bc` is not installed; `... | paste -sd+ | bc` yielded an empty string and the comparison never matched |

The `--noproxy` one generalises furthest: the earlier note in this document said a fetch must use a
non-loopback target and `--noproxy ''`, and that only ever worked because `--proxy socks5h://`
overrides it explicitly. As a *control* — no `--proxy` — the same flag sends the request straight
through Squid.

The others share one shape: **a run that cannot work should say so, not produce a number.** Every
check in `run25.sh` is now fatal and named — a control fetch that must succeed before tor is started,
a preflight that refuses to run while the last run's ports are held, an explicit "NEVER BOOTSTRAPPED"
line, and a readiness loop that reports what it saw instead of expiring in silence. The `bc` one had
been silently failing since the script was written; making the check fatal is what surfaced it.

### Microdescriptors, and the flavour our own client had always asked for

Step 5 wants a network with no C in it: our client, through three of our relays. It was blocked by
something neither half could see on its own. `dirclient.wac` fetches
`/tor/status-vote/current/consensus-microdesc` and then microdescriptors by each entry's `m` digest;
the authority produced only the **ns** flavour and answered that path with a 404. So **no client in
this package could bootstrap from an authority in this package** — two halves each validated against C
tor and never against each other, which is exactly what D1 is about, arrived at from the opposite
direction to the `linkHandshake` case.

Every live run until now hid it behind `UseMicrodescriptors 0` in the probe's torrc. That line began
as a measurement — "does the ns path complete?" — and quietly became a crutch holding up a network
that could only ever serve a C tor.

What was added: `src/microdesc.wac` (the document, its digest, and splitting a concatenated response
back apart), the microdesc consensus flavour in `consensusgen.wac`, the `/tor/micro/d/` route in
`dirserve.wac`, and `-M`/`-m` on `relayd` with `<consensus>.micro`/`.mds` beside the consensus for
`dird`.

Measured, with the crutch removed — the torrc has no `UseMicrodescriptors` line at all:

    Received answer to microdescriptor request (status 200, body size 1176) from server 127.0.0.1:5557
    A consensus needs 1 good signatures … This microdesc one has 1 (wacauth).
    Bootstrapped 100% (done)

**Read the order, not the last line.** tor logs `We need more microdescriptors: we have 0/3` until they
arrive, and both of those lines sit *above* the answer in the log. Grepping for the last one said 0/3
and I read it as a failure; what settles it is that the last shortfall is at line 265, the answer at
271, and `enough_dirinfo` at 274 — a state tor does not reach without accepting them. The run script
now prints those line numbers rather than a count, because the count was the misleading part.

### A microdescriptor's verdict is its digest

`tools/microdesc-probe.c` puts a document through tor's own `microdescs_parse_from_string`. Corrupting
it, the way the other probes were exercised:

| mutation | verdict | digest |
|---|---|---|
| unmodified | ACCEPTED | `Xkm7p1…` |
| the `onion-key` keyword damaged | REJECTED | — |
| the `id` line removed | ACCEPTED | `gNEkkd…` |
| one character of the ntor key | ACCEPTED | `TWTjPz…` |
| one byte of the RSA key | ACCEPTED | `9PsLZ9…` |
| the lines reordered | ACCEPTED | `wePWVc…` |
| the trailing newline dropped | ACCEPTED | `p+VzFA…` |

So ACCEPTED means *structurally parseable* and nothing else — weaker even than a consensus's, which at
least checks digests. Everything that distinguishes a right microdescriptor from a wrong one lives in
the digest, and the consensus's `m` line is what commits to it. A client that computes a different one
discards the document and reports only that it has no usable relays. The tests pin the digest; the
verdict is the weaker second thing.

Two details worth keeping, both of which parse either way and hash differently:

  - **The `m` line comes before the `s` line**, not after it.
  - **`p` is omitted entirely when the summary is `reject 1-65535`**, rather than written out.

And one that is not about digests at all: **`/tor/micro/d/` batches with a hyphen, not a `+`.** Every
other batched path in the protocol uses `+`, and `+` is a *data* character in base64 — so a route that
split on it would cut roughly half of all digests in two and answer 404 for the batch. Case matters
there too, where the hex paths fold it.

Faults planted after the tests went green, and the result of each: writing `p` unconditionally,
reversing tor's line order, dropping the trailing newline, misspelling the `ntor-onion-key` keyword,
and digesting the wrong bytes — all caught. Splitting the microdesc path on `+`, and serving
microdescriptors for a request naming none of them — caught. **Case-folding the base64 comparison
survived**, because no test asked for a digest with its case changed; an assertion for it was added
and the same fault is caught now.

### A network with no C in it

Step 5's *done* condition: "the suite stands up a network with no C in it and a client fetches through
three of our relays." The condition is met. The deliverable it belongs to is not yet — see below.

Nothing in this run is C tor. Our `gendesc` produced the documents, our `dird` served them, three of
our `relayd` carried the traffic, and our `socks.wac` was the client:

    control: direct fetch gave 4004 bytes
    consensus verified: 1 of 1 authorities signed
    guard: wacrelay3
    building circuit 0 for port 8088
    circuit 0 for port 8088: wacrelay3 -> wacrelay -> wacrelay2
    stream 1 -> 192.168.80.2:8088 on circuit 0
    stream 1 ended: done
    fetch attempt 1 exit 0 bytes 4004
    BODY: identical to the file the server holds

and on the exit relay's side, `stream … open to 192.168.80.2:8088`.

Every seam in that path has our code on **both** sides — our TLS client against our TLS server, our
link initiator against our link responder, our consensus reader against our consensus writer, our
microdescriptor reader against our writer, our `RELAY_BEGIN` against our exit. That is exactly the
arrangement D1 says proves the least, and it is why this is reported next to the C tor run rather than
instead of it: the same code reached `Bootstrapped 100% (done)` with tor 0.4.7.13 on the other side of
the directory, and carried a stream for it. Two mutually-blind witnesses to the same path.

Worth keeping from the way this arrived: `app.wac` was tried first and answered
`the directory answered 404`. That was not a bug — `app.wac` fetches *directory* paths over
`BEGIN_DIR`, which is what its header says, and 404 is the correct answer for `/probe.txt`. It had
already proved the interesting half by then (`consensus verified`, `circuit built, 3 hops`), and the
program that opens an ordinary stream is `socks.wac`. Reading the failure as the client being broken
would have cost an hour looking at working code.

**What is still owed for step 5.** The step asks for a *launcher* — "bring up a mixed network from a
description, wait for bootstrap, run something across it, tear it down" — and what stood this network
up is a shell script in a scratch directory, not a program in this repo, and not something the suite
runs. The condition is evidence that the launcher has something to launch; it is not the launcher.

### The launcher

`src/network.wac`. A description names each server, **the line it prints when it is genuinely
listening**, and the work to run once they are all up; the launcher spawns them all at once, waits on
every one of their output streams through a single `waitAny`, runs the work, and stops everything.

The specification came from the scripts it replaces. Every one of their failures was a stage assumed
rather than observed, so: a node is waited for by marker and never slept on; a node that does not
announce itself fails the run **by name**, and the work does not run; the work's exit code is the
run's, so a network that came up and a fetch that failed cannot read as success; and a description
that asks for nothing to be run is a failure rather than a quiet zero.

Controls, because a launcher that always says ok is worse than none. Four networks broken on purpose:

| what was broken | what it said |
|---|---|
| a relay's ready marker names a port it will never listen on | `relay2 never said "listening on 127.0.0.1:9999"` |
| the client trusts an authority that signed nothing | `network: failed with 1` |
| a node's bundle is not on disk | `authority: nosuch.worker.js: No such file or directory` |
| no nodes at all | `the description has no nodes, so there is no network to run across` |

Six faults planted in the launcher after its tests went green — treating "started" as "up", ignoring
the work's exit code, running the work anyway when a node never came up, calling a description with no
work a success, swallowing a missing bundle, and matching the ready marker against only the latest
read — all caught. A seventh, merging the child's two streams onto stdout, was caught after the
assertion for it was added; see below.

**Two stream bugs, one at each level, found by looking at the output rather than the exit code.** The
launcher's own progress went to stdout, so `network net.txt > doc` produced a document with
`network: ok` in the middle of it; and `runOnce` forwarded both of a child's streams to stdout, so the
client's `consensus verified` and `path:` lines landed in the fetched document too. Both are the same
mistake — a program mixing what it says about itself with what it was asked to produce — and neither
shows up in an exit code. Fixed at both levels, and `app.wac`/`bootstrap.wac` had it too.

The payoff is a much stronger end-to-end assertion than "the fetch succeeded": **stdout is now
byte-identical to the microdesc consensus the authority holds**, having come back through a three-hop
circuit. `cmp` is the whole check.

    network: all 4 nodes are up
    consensus verified: 1 of 1 authorities signed
    path: wacrelay2 -> wacrelay -> wacrelay3
    circuit built, 3 hops
    network: ok

about a second, on a quiet machine.

**Two things it does not do, both stated rather than discovered.** It cannot start a C tor: `Cli.spawn`
takes a worker bundle and this world deliberately has no capability for running an arbitrary binary,
so "a mixed network" in this document's sense needs a platform change and the C tor half of the
interop matrix stays a shell script. And **the suite does not stand up a Tor network with it** — the
ports a relay listens on are baked into its signed descriptor, so two agents running the suite at once
would collide on 5555. `test/network.test.ts` tests the launcher against `packages/platform/example/waiter.wac`, which
is the right subject anyway: it knows about processes and ready markers, not about Tor.

### Step 6 begins: ESTABLISH_INTRO, and a span nothing in the cell hints at

The first cell an onion service sends. `src/hsservice.wac`, pinned by `tools/estintro-probe.c`, which
puts the cell through tor's own `trn_cell_establish_intro_parse` and then tor's own
`crypto_mac_sha3_256` and `ed25519_checksig_prefixed`.

The layout is `src/trunnel/hs/cell_establish_intro.trunnel`, and the two `@ptr` markers in it are the
entire difficulty:

    auth_key_type   1        <- start_cell
    auth_key_len    2
    auth_key       32
    extensions      1 + …
                             <- end_mac_fields
    handshake_mac  32
                             <- end_sig_fields
    sig_len         2
    sig            64

The MAC covers everything before the MAC, which is the obvious thing. **The signature covers
everything before `sig_len`** — so it includes the MAC and excludes the two length bytes that follow
it. "Everything before the signature", the reading anyone would take from the cell's shape, is two
bytes too long.

That is not an argument, it is a measurement. A cell signed the obvious way, with the same key over
the same fields:

    parsed_bytes: 134
    mac: ok
    REJECTED
    reason: signature not as expected

It parses, its MAC verifies, and tor refuses it. Nothing but the position of a marker in a trunnel
file distinguishes the two, so the test reads both span lengths **out of tor's parsed cell** rather
than recomputing them — a comment can drift from the code, and this cannot.

**Unlike a microdescriptor, this cell's verdict is worth something.** It carries a MAC and a
signature and tor checks both, so ACCEPTED means the bytes are right rather than merely well-shaped.
Measured rather than assumed — every mutation refused, and the table is in the fixture so a test built
on the verdict can say what the verdict is worth:

| mutation | tor |
|---|---|
| unmodified | ACCEPTED |
| one bit of the auth key | `handshake_auth not as expected` |
| one bit of the handshake MAC | `handshake_auth not as expected` |
| one bit of the signature | `signature not as expected` |
| the wrong circuit KH | `handshake_auth not as expected` |
| `auth_key_type` 1 instead of 2 | `handshake_auth not as expected` |
| truncated | `parse returned -2` |
| **signed over the obvious span** | `signature not as expected` |

Two other things worth keeping. `crypto_mac_sha3_256` — SHA3-256 over the key length as eight
big-endian bytes, then the key, then the message — is exactly `hsMac`, which the client half already
had; the service reuses it rather than growing a second one. And **node's Ed25519 reproduces our
signature byte for byte**, which is the check that matters: our signer feeding our verifier can agree
on a wrong answer, and node shares no code with us.

Faults planted after green — signing the obvious span, signing only the MAC span, dropping the
prefix, swapping the MAC's key and message, omitting the extension count, the wrong auth key type,
and a `sigSpanOf` that forgets the MAC — all seven caught.

What step 6 still needs: INTRODUCE2 parsing (the inverse of `introduce1Cell`), the hs-ntor
*responder* keys mirroring `clientIntroduceKeys`/`clientRendezvousKeys`, RENDEZVOUS1, and descriptor
building and publication — the inverse of `hsdesc.wac`'s decryption. The cell above is the one they
all hang from, because a service with no established introduction point has nothing to publish.

### The hs-ntor responder, checked against tor on both sides

`serviceIntroduceKeys` in `hsntor.wac`, beside its client twin rather than folded into it with a flag.
Only the *inputs* differ — the service holds the secret half of `enc-key ntor` and receives the
client's ephemeral public key in the cell, where the client holds the public half and its own secret —
and everything hashed after that is identical and in the same order. That sameness is the whole reason
a client and a service agree, so the two lists are worth seeing side by side.

The oracle is tor's own `test-hs-ntor-cl`, which `capture-hsntor.py` already used for the client half;
it now runs **`server1` as well as `client1`** over the same inputs and **refuses to write a vector if
the two disagree**. So the expected value in the fixture is tor's twice over, and our service is
compared against tor rather than against our client. Checking our service against our client would
pass for a pair sharing a mistake — which is the seam that produced the `linkHandshake` bug and the
microdesc-flavour gap, both found only when something of tor's was put on the other side.

Re-capturing changed **four lines** of the committed vector — one `introEncSecret` per case, with
every derived value byte-identical. That is the check that the capture is deterministic and that
adding the service side disturbed nothing.

Faults planted: swapping the arguments to `x25519`, hashing the service's secret where its public key
belongs, dropping the degenerate-key refusal, and omitting the subcredential — all four caught.

One thing the test file's own history caught for me: it already had a `flipScalar` beside `flip`,
because flipping byte 0 of a curve25519 secret breaks the clamping and turns a test about key
derivation into a test about clamping. Mine had used `flip`.

### INTRODUCE2, and the symmetric oracle caught in the act

A service's `parseIntroduce2`, the inverse of the client's `introduce1Cell` and `introduce1Plaintext`.
An INTRODUCE2 is byte-for-byte an INTRODUCE1 — the introduction point relays the body unchanged and
only the relay command differs — so this repo now holds both ends of one format, which is exactly the
arrangement that has caught it out before.

It caught it again, and this time in the act. **tor pads an INTRODUCE1 to a fixed size; our client's
builder does not.** The first version of the parser returned "the rest of the plaintext" as the link
specifier list, which is right for every cell our own client builds and returns *two hundred bytes of
padding* for one of tor's. `linkSpecifiersValid` requires the list to be exactly consumed, so a
service would have refused a perfectly good cell and failed to build the rendezvous circuit — and no
round trip through our own code could have shown it. The parser now walks `NSPEC` entries and stops.

The oracle is `tools/introduce-probe.c`, which calls tor's own `hs_cell_build_introduce1`. Our service
recovers, from a cell tor wrote, every value tor was given:

    authKey      5befac73…   clientPublic 9f53d870…
    rendCookie   be5aa96b…   rendOnionKey d7aae69c…
    linkSpecifiers 0100067f0000012329

**The reverse direction is not available and the reason is worth recording.**
`hs_cell_parse_introduce2` asserts on its `circ` argument — it wants a real `origin_circuit_t` for
replay caching, so passing NULL aborts rather than returning an error. Feeding one of *our* cells to
tor's parser therefore needs a running service, which is a chutney network rather than a probe. The
probe had a `parse` mode for about ten minutes; it is gone, because a mode that aborts is worse than
an absent one, and the comment claiming "the parse reads neither argument" was simply wrong.

Also here: `rendezvous1Cell`, and a constant-time MAC comparison — a service answers strangers, and a
check that returns at the first differing byte turns forging a MAC from 2^256 work into 32 × 256.

Nine faults planted. Eight caught immediately: returning the padding, skipping the MAC, using the
span the specification describes rather than the one tor uses, including the MAC in its own input,
decrypting `CLIENT_PK` along with the data, a non-zero IV, swapping `ENC_KEY` and `MAC_KEY`, and
putting the handshake before the cookie in RENDEZVOUS1.

**One survived: accepting a non-zero `LEGACY_KEY_ID`.** The test flipped that byte and expected a
refusal — but `LEGACY_KEY_ID` is inside the MAC span, so the MAC check refuses it whether or not the
structural check exists. The check only bites on a cell whose MAC is *valid over the modified bytes*,
which is what a v2 introduction point would actually relay. A case that re-MACs the cell was added,
and the same fault is caught now.

### Flow control does not break large transfers, and the reason is not us

The biggest untested risk in step 3 was flow control: `relayd.wac` contains no `SENDME` handling and no
window accounting at all. The prediction was that a transfer larger than the initial stream window —
500 cells of 498 bytes, about 249 KB — would stall or be killed.

**Wrong, three times.** A ladder of 64 KB, 200 KB, 400 KB and 1 MB all arrived byte-identical. A
deliberately slow reader (1 MB at 20 KB/s) arrived. Eight megabytes at 100 KB/s — eighty seconds of a
reader far slower than the sender — arrived, byte-identical, with tor logging nothing about windows at
all.

Reading tor rather than guessing a fourth time explains it, and the explanation is worth keeping
because it says when the missing code *would* matter:

  - **Circuit-level SENDMEs are sent unconditionally.** `sendme_circuit_consider_sending` runs after
    every DATA cell and has no output-buffer gate, so the circuit window is always replenished. Only
    *stream*-level SENDMEs are held back when `connection_outbuf_too_full`.
  - **tor applies back-pressure below the protocol.** When its buffers fill it stops reading the OR
    connection, so our cells wait in the kernel instead of overrunning a window. An exit that sends as
    fast as it can is throttled by TCP long before it can exceed what tor has advertised.

So the missing window accounting is invisible in the direction everything has been tested in. That is
not "it works" — it is "the thing that would have caught it cannot happen here", which is a different
statement and the useful one.

### The direction nobody had tested

Every live test in this document is a **download**. Turning the same harness around — a 64 KB POST
through the same three relays to a sink that counts what it reads — fails: about 3 KB arrives and the
relay reports `stream N closed by the far end` when nothing has closed. Twice, with different byte
counts, and with a direct POST of the same body to the same sink succeeding in the same run.

Filed as **issue 0089** rather than fixed here, because the fix depends on which of two suspects it is
and one of them is in the platform rather than in Tor. The asymmetry that makes it interesting: a
download reads one socket and writes another, while an upload writes a socket that already has a
`recv` outstanding on it.

Step 3's line in the state table said "a stream carries bytes". It does — in one direction. The table
now says which.

### Chasing 0089: two hypotheses, both wrong, and a better question

The upload failure was worth an hour because each wrong answer narrowed it.

**First hypothesis — the platform breaks a read when the same handle is written.** It was the only
structural difference between the two directions, so it was worth asking without Tor in the way.
`packages/platform/example/writeread.wac` asks it in forty lines: connect to a peer that never speaks,
issue a `recv`, then `send` twenty times and poll after each. *Still pending after 20 sends.* The
platform is fine, and the example stays because the question will be asked again.

**Second hypothesis — the relay truncates the body after about six cells.** Byte counters per stream
killed that one: the `stream closed by the far end` line that started the issue turns out to be the
*GET control*, closing normally after `89 bytes in, 69 bytes out` — exactly a curl GET and exactly the
sink's reply. The upload stream is the *next* one, and it has no closing line at all.

**What it actually is.** With the first data cell each way logged, the upload stream never carries one.
tor's log says why: `circuit_mark_for_close_ … orig reason: 520`, which is the remote flag with
`CHANNEL_CLOSED` — **one of our relays destroyed the circuit** right after the second stream opened on
it. So the fault is not in forwarding data; it is in what happens to a circuit when a stream closes
and another begins on it.

Two things this leaves behind that are worth more than the fix will be. `relayd` now counts bytes each
way per stream and logs the first cell in each direction, so a stalled stream no longer looks
identical to one that was never written to — the same argument that found the accept spin. And the
issue records both dead hypotheses, because the reasoning that produced them was sound and someone
will have it again.

### Pinning the exit, and what is actually left of 0089

`ExitNodes` plus `StrictNodes 1` removes tor's random choice of exit, and the upload failure becomes
the same sequence every run. Worth having written down as a technique: three relays and a random exit
means each run instruments a third of the network, and three runs that each answer a third of the
question answer none of it.

With that, the remaining lead is **optimistic data**. tor logs `does allow optimistic data` and sends
the request immediately after BEGIN, without waiting for CONNECTED — so the DATA cells arrive while
`relayd` is parked in the blocking `cli.connect(…).wait()` that a BEGIN performs. A GET's request
arrives the same way and works, because it is small enough to share a record with the BEGIN; a POST's
does not. Nothing in this stack has ever exercised that.

Two things found on the way, neither of them 0089:

  - **Issue 0091.** The platform ring has sixteen slots and an outstanding call holds one.
    `socks.wac` caps itself at twelve and says exceeding the ring deadlocks rather than degrades.
    `relayd` allows 64 connections of 8 circuits, and a *single* connection at that limit needs 17
    outstanding calls before the accept ticket is counted. Filed rather than fixed, because what a
    relay refuses under pressure is a decision.
  - **`could not reach 127.0.0.1:5557`** — one relay failing to connect to another with the port open
    and the peer running, recurring across runs. Recorded in 0089 as explicitly *not* part of it.

And the instrument for next time is somebody else's: agent-a's `host/schedule.ts` makes the host
answer one worker at a time in a chosen order (`WAC_SCHED=fifo`, or `seeded:N`). `network.wac` already
runs the relays as workers of one host, so a launcher-run network can be replayed exactly and a
working run diffed against a failing one.

### 0089 narrowed to one sentence, and four suspects eliminated

Worth recording as method rather than as result, because the result is still "not fixed".

Eliminated, each by an experiment rather than by reasoning: **the platform** (`writeread.wac`, twice —
once with a peer that never reads and again with one that does); **uploads as such** (a 100-byte POST
works); **the second stream on a reused circuit** (a second GET works); and **`Expect: 100-continue`**
(the same body fails with the header suppressed).

What is left: *every request whose entire body fits in one relay cell works, and the one that needs
several receives nothing at all.* In runs where the stream is torn down first, six `RELAY_DATA` cells
then arrive for a stream that has already gone — so the cells are not lost, they are late, and whether
the teardown or the data comes first varies between runs. That is a race.

Three instrumentation defects of mine had to be fixed before any of this was visible, and they are the
transferable part: per-stream byte counters that were never reset (so every count after the first was
cumulative), log lines with no connection number (so three connections interleaved indistinguishably),
and no record of a forward at all (so a stalled stream looked exactly like one nothing was written to).
Each was found by the log failing to answer a question I already knew how to ask.

### FlowCtrl was advertised in two documents that disagreed

Not a fix for 0089 — it was tested as one and changed nothing — but a real defect found by looking.

`consensusgen.wac` and `vote.wac` advertised `FlowCtrl=1-2` on every relay's `pr` line while
`routerdesc.wac` advertised `FlowCtrl=1` on the same relay's descriptor. Two documents describing one
relay, disagreeing about what it can do, and tor negotiates from the consensus. **We implement
neither version**: `relayd.wac` sends no `SENDME` at all.

Version 2 is proposal 324 congestion control, whose window starts small and grows only as the receiver
returns credit. Advertising it invites a client to open a circuit with a few kilobytes of window and
then wait forever — which is exactly what an upload does here, though changing the advertisement did
not fix it, so the mechanism is something else.

Both now say `FlowCtrl=1`, matching the descriptor. The generated vote and consensus fixtures were
regenerated and re-checked: C tor's parsers accept the descriptor, the certificate, the vote (whose
acceptance includes verifying its signature) and both consensus flavours. A fixture that satisfies
only our own tests would have proved nothing.

### 0089 solved: a partial TLS record, and the flow control hiding underneath it

`tlsServerFeed` takes **whole records only** and traps otherwise — its own comment says so, and
`recordsReady`/`tlsRecordNeeded` exist so a caller can honour it. `link.wac`, our client, calls it.
`relayd.wac` did not: it passed whatever `recv` returned straight in.

That is invisible while every record happens to arrive intact, which is every small exchange. It fires
the moment enough data arrives at once for a record to straddle two reads — and then the trap kills
the connection, tor reports `CONNRESET` or a TLS error, and **every circuit on that connection dies at
once**. Which is exactly what the log showed all along: three circuits marked for close in the same
millisecond, an `ORCONN DELETE … reason=4`, and nothing at all on our side.

`link.wac`'s own comment was the warning: *"a reader that mostly works fails on a fast connection
rather than a slow one."* Issue 0029 recorded this rule scoring one correct and one silently broken.
This was the second silently broken one, and it took six hypotheses to find because the symptom
appears three layers above the cause.

**And underneath it, the thing I had already predicted and wrongly abandoned.** With the trap gone the
limit moves to exactly where the protocol puts it:

| upload | before the fix | after |
| --- | --- | --- |
| 64 KB | fails after ~3 KB | works |
| 200 KB (411 cells) | fails | **works** |
| 300 KB (617 cells) | fails | fails |

A stream's window is 500 cells of 498 bytes — 249,000 bytes, between those two. `relayd` sends no
`SENDME`, so the client's package window is never replenished. The original prediction that missing
flow control breaks large transfers was **right about uploads all along**; it could not be seen
because a worse bug fired two orders of magnitude earlier, and it looked disproved because downloads
are held inside their window by tor's own back-pressure. Implementing `RELAY_SENDME` is now ordinary
work rather than a mystery.

The method worth keeping: six hypotheses, each killed by an experiment rather than an argument, and
three rounds of fixing my own instrumentation before the log could answer the question. The cause was
found by reading a contract — `tlsServerFeed`'s comment — not by reasoning about Tor.

### `RELAY_SENDME`, and the last of 0089

The half of 0089 left after the TLS record fix: a client's window is 500 cells per stream and 1000 per
circuit, each `SENDME` returns 50 or 100, and `relayd` returned none — so an upload stopped dead at
the initial window and never resumed.

Implemented as **version 0** SENDMEs, an empty body, circuit-level every 100 data cells and
stream-level every 50. Version 1 carries the digest of the cell that triggered it; tor's
`sendme_accept_min_version` defaults to **0**, so the simple form is accepted and no digest has to be
threaded out of the relay crypto. Our *client* already emits v1, so if a consensus ever raises that
minimum the upgrade is reuse rather than new work.

The circuit-level count deliberately covers **every** `RELAY_DATA` on the circuit, including the
directory stream's, because that is what spends a client's circuit window — keeping it inside the
branch that handles one stream would undercount by exactly the cells that are hardest to notice.

Measured on the same script and network, before and after:

| upload | before | after |
| --- | --- | --- |
| 200 KB (411 cells) | works | works |
| 300 KB (617 cells) | **fails** | **works** |
| 1 MB (2105 cells) | **fails** | **works** |
| 4 MB (8400 cells) | — | **works** |

with 34 circuit-level SENDMEs emitted on the run. The 4 MB case is there because a fix that merely
moved a threshold would look identical at 1 MB. The failing column is not a recollection: it is the
immediately preceding run of the same script against the previous binary, which is the control this
kind of claim needs.

So step 3's row is now true in both directions, and the two halves of 0089 together are a decent
illustration of why a symptom is not a diagnosis: the same observation — "an upload stops" — had two
independent causes stacked, one at the TLS layer and one at the Tor layer, and the lower one hid the
upper one by two orders of magnitude.

### The descriptor, built outside in — and an oracle at each layer

`src/hsdescgen.wac`, the writing half of `hsdesc.wac`. The outer document is done and pinned:

    version: 3        lifetime_minutes: 180      revision_counter: 42
    signing_pubkey: Fs50Sc84KEoX6FE2wUFCpHXxaquCMAikIFRAumDA3AA
    ACCEPTED

**Why the outer shell alone was worth doing.** `hs_desc_decode_plaintext` verifies the version, the
lifetime, the signing-key certificate and the signature, and treats `superencrypted` as an opaque
object — so the shell can be checked with a stand-in blob in place of the layers. Without that entry
point the first verifiable unit would have been the whole descriptor, three layers deep, built blind.
Finding it was worth more than any of the code.

The signature span is the trap again: tor finds `"\nsignature "`, steps **past the newline**, and
signs everything before that. One byte either way parses and fails to verify — the third span in this
package with that shape, after the descriptor digests and ESTABLISH_INTRO.

Also settled: **`expirationHours` is hours since the epoch, not a duration.** Passing 54 meaning "54
hours from now" set the certificate to expire in 1970, and tor rejected the descriptor without saying
which of a dozen checks failed. `relaycert.wac` says so in its own comment; I did not read it. That is
the same lesson as the TLS record contract, two hours apart.

**And a near-miss worth more than the fix.** The control table first reported "one character of the
certificate — ACCEPTED", which read as a real gap in tor's checking. The string being replaced came
from the *previous* generated document and appeared nowhere in the current one, so the mutation
changed nothing: a no-op that is indistinguishable from a surviving fault. A careful re-run, decoding
the certificate and flipping actual bytes, showed the signature, the expiry and the certified key are
all checked. Every fault planted since asserts the source actually changed before running the tests.

### The middle layer, and an oracle for it too

tor's own decoder chains `plaintext -> superencrypted -> encrypted`, so stopping after two stages is a
supported position rather than a trick — `tools/hsdesc-probe.c` grew a `super` mode that does exactly
that. The middle layer now decrypts:

    auth_clients: 16       encrypted_blob_len: 64       ACCEPTED

Two things about that layer are worth knowing because neither is arithmetic:

  - **The sixteen `auth-client` lines are decoys.** With no client authorised, tor still writes a
    fixed number, so a descriptor's shape does not say whether a service restricts access. A generator
    that omitted them produces a document that *parses* — the token rule wants one or more — and leaks
    by its size.
  - **Only this layer is padded**, to a multiple of ten thousand bytes (`build_plaintext_padding`,
    called only when `is_superencrypted_layer`). That is why the descriptor jumped from 668 bytes to
    14103 the moment the layer became real, and why every real descriptor is at least ten kilobytes
    whatever the service is.

Controls on the new stage: another service's subcredential, one character of the blob, and the
revision counter that keys it — all three rejected by tor.

**A planted fault survived and the reason generalises.** "Round the padding down instead of up" passed
every test, because a plaintext under one block rounds down to zero and a guard turns zero back into
one block — so up and down agree for every input the tests had. It is caught now by a case one byte
*over* a block. The lesson is that a boundary guard can hide the very arithmetic it guards, and a
single-size test cannot see it: the fault needed an input on the other side of the boundary, which is
exactly the input a fixture built from one real document never has.

### The whole descriptor decodes — and `ACCEPTED` was nearly believed again

    intro_points: 1     ACCEPTED

tor decrypts both layers, parses the introduction point and validates both of its certificates.
That completes the descriptor; what step 6 still owes is publication, real key blinding, and the
program.

**Read the count, not the verdict.** Three deliberately-wrong descriptors were built to check the
oracle, and all three came back `ACCEPTED` — which was recorded, briefly, as "tor does not check
this". It does: tor **drops** an introduction point whose certificates fail and returns success for
the descriptor, so the real signal was a field the control was not printing.

| how it was built | tor |
|---|---|
| correctly | ACCEPTED, `intro_points: 1` |
| auth-key cert signed by the blinded key | ACCEPTED, **`intro_points: 0`** |
| auth-key cert with the wrong cert type | ACCEPTED, **`intro_points: 0`** |
| enc-key-cert certifying the curve25519 key itself | ACCEPTED, `intro_points: 1` |

That is the third time this week a verdict has been weaker than it looked — after a microdescriptor's
ACCEPTED, and a consensus's. The pattern is worth stating as a rule: **when a checker's answer is
"fine", find the field that counts what it kept.**

The last row is a fact about tor rather than about us. It validates the cross-certificate's signature
and type but never checks that the key inside is the ed25519 form of the encryption key — so *this*
oracle cannot confirm the proposal 228 conversion at all. The conversion is used here on the authority
of `routerdesc_wac.test.ts`, which pins it against tor's own vectors, and the descriptor tests say so
rather than implying a check they do not perform.

Two smaller things the format fixes and nothing hints at: both intro-point certificates are signed by
the **descriptor signing key** — not the blinded key, and not each other — and the inner layer is
**not** padded, so its length tracks the number of introduction points. The middle layer's padding is
what hides that from anyone who has not decrypted that far.

### Key blinding's other half, and why no descriptor test could have caught it

`hsblind.wac` derived the blinded **public** key — everything a client needs, pinned long ago against
a key tor published. A service needs the blinded **secret**, because it signs the descriptor's
signing-key certificate with it. That was the piece the descriptor work stood on top of without
having: `genhsdesc.wac` used an ordinary keypair where a real service must use a blinded one.

**The reason it needed an oracle of its own is the interesting part.** Nothing in a descriptor says
which key signed it — tor verifies the certificate against the key carried *inside* that certificate.
So a wrong blinded secret produces a descriptor that decodes perfectly for anyone who does not know
the identity key, and fails only for the clients who matter, because only they derive the blinded key
independently and expect it to match. `hsdesc-probe.c` accepts such a descriptor happily. That is not
a gap in the probe; it is what the format allows, and it means the descriptor oracle — however
thorough — is structurally incapable of checking this.

So `tools/blind-probe.c` calls tor's own `ed25519_keypair_blind`, and the derivation is now pinned
against it:

    a'  = a * h  (mod L)
    RH' = SHA-512("Derive temporary signing key hash input" | RH)[0..32]

The prefix half is **rehashed** rather than carried across; reusing it would have two keys sharing a
nonce derivation, and a service signing with both would leak its identity scalar.

The captured signature earns its place separately from the key: a scalar wrong by a factor of the
cofactor is still a scalar and still produces sixty-four plausible bytes. Both directions are checked
— tor's signature verifies under the key we derived, and ours is byte-identical to tor's.

Six faults planted, all caught, including "clamp the blinded scalar again" — which is the plausible
mistake, since every *other* scalar in ed25519 is clamped and this one must not be.

### Publication, and the name the uploader does not choose

Publishing looked like the least interesting thing step 6 owed — a POST with a document in it. The
part that is not obvious is that **the uploader does not name the descriptor**. `/tor/hs/3/publish`
carries no key at all; an HSDir reads the blinded key out of the descriptor's own signing-key
certificate and files it under that. Only the *fetch* path has a name in it.

So the failure this had to be tested against is a service that blinds correctly, signs correctly,
uploads successfully, is told `HS descriptor stored successfully.`, and is unreachable — because the
name it computes for the fetch URL is not the name the directory used. Every check short of asking a
real directory what it called the thing would pass.

`tools/hspub-probe.c` asks one. It stores our generated descriptor with tor's `hs_cache_store_as_dir`
and looks it back up with `hs_cache_lookup_as_dir`, under the base64 blinded key `descriptorPath`
puts in the URL. It hits, and the bytes tor would serve back are the bytes uploaded — which matters
on its own, since a client verifies a signature over exactly those bytes.

The four controls are recorded in the vector, and one of them is doing different work from the other
three:

| control | tor |
|---|---|
| one byte of the encrypted body flipped | refused |
| the document signature corrupted | refused |
| truncated after the first line | refused |
| **the right descriptor, under an all-zero key** | **stored, and not found** |

The first three only show that tor reads the document. The last is the one that separates a bad
descriptor from a bad *name*, which is the failure the whole file exists for.

The version parse is worth following exactly rather than matching `/tor/hs/3/publish` whole, because
that path and `/tor/hs/3/<z>` differ only after the version and one is a POST target while the other
is a GET target. tor reads a number after `/tor/hs/` and then requires `/publish`, so
`/tor/hs/003/publish` is a v3 publish and `/tor/hs/3publish` is not a publish at all.

Two planted faults survived the first pass. One was equivalent — a short-circuit that returned the
same answer. The other was real: with the "there must be digits" guard removed, an absent version
read as zero, and the obvious probe for it (`/tor/hs/publish`) could not see it, because the
`/publish` check refuses that input whichever way the number parse goes. `/tor/hs//publish` is the
input that tells them apart. **A guard is only tested by an input that reaches it** — the same shape
as the padding boundary a few sections above.

### A directory's verdict, and two ways to be wrong about a limit

Wiring publication into `dird` meant writing the check tor's `desc_decode_plaintext_v3` performs, and
reading that function found a mistake in each direction — which is the argument for reading it rather
than inferring it from the descriptors we happen to have.

**Too permissive.** tor refuses at `encoded_len >= hs_cache_get_max_descriptor_size()`. A `>` agrees
with that on every input except one length, and that length is a document every real directory
rejects and we would have stored and served. Both sides of the boundary are tested now, which is the
same lesson the superencrypted padding taught: a single-size fixture cannot see an off-by-one, because
the input that distinguishes them is the one it does not contain.

**Too strict.** The version was being required on the first line. tor uses `find_by_keyword` and does
not care where it is. A directory stricter than the network refuses documents every client would have
accepted — and that failure is worse than the obvious direction, because it looks like the uploader's
fault.

The controls for all of this are tor's own. `capture-hspub.py` now records each control as an *edit* —
an offset and a byte, or a truncation length — rather than as a description, so the wac tests replay
the exact bytes `hs_cache_store_as_dir` was handed. A control the two ends build separately from a
description is a control they can quietly stop sharing.

The socket test opens with a fetch of a descriptor nobody has published. Without that 404 the later
200 shows only that the server answers. The upload is then sent in four pieces with a pause between
them: a descriptor is fourteen kilobytes and a POST that arrives in one read is a claim about the test
rather than about the server. Planting "give up on a partial request" is caught by exactly that case,
which is how we know the multi-read path is the one being exercised — issue 0089 was this shape.

Two of the fifteen planted faults survived, and both were redundancy in the new code rather than gaps
in the tests: a second version check masking the first's mutation, and a status written twice so the
mutation landed on the dead copy. Worth naming as a pattern — **a surviving mutant sometimes points at
duplicated logic rather than a missing assertion**, and the fix is to delete the duplicate, not to add
a test for it.

### DirPort 0, and a transport question answered by evidence

Publication from a service was going to need one of two transports: a direct connection to a
directory's DirPort, or a BEGIN_DIR stream over a circuit. The usual argument is anonymity — a
service that connects directly to a directory has told that directory where it is — and the usual
argument is enough, but it is the kind of reasoning that leaves a shortcut looking merely
inadvisable.

The consensus captured from a real network in `test/data/hsdir_vectors.json` settles it as a fact.
Of thirteen relays, ten have `DirPort 0`, and **all eight of the HSDirs tor actually uploaded to are
among them** — only the three authorities publish a DirPort at all. A service uploading to DirPorts
would have nowhere to upload to. BEGIN_DIR is not the private route to an HSDir; for an HSDir it is
the only route.

    r test012r ...  127.0.0.1 5112 0      ← an HSDir tor published to
    r test002a ...  127.0.0.1 5102 7102   ← an authority

So `relayd` answers a publish on its directory stream, and the accumulate-parse-answer loop it shared
with `dird` — written out twice, and already diverged, since only `dird` had learned to accept an
upload — is now one function of the bytes so far.

The property both copies needed and neither stated: **nothing is answered until the whole request is
present.** A directory that replies to the first read of a fourteen-kilobyte upload passes a verdict
on a document it has not seen, and the reply is plausible rather than obviously wrong — a truncated
descriptor is refused, so the service would be told its descriptor was malformed when it was only
still in flight. That is issue 0089's shape from the other side of the wire.

One planted fault survived and was worth the exercise: the method was not checked, so a `GET
/tor/hs/3/publish` would have been handled as an upload and answered 400 — a directory telling a
client its descriptor was invalid when the client never sent one. tor reaches
`handle_post_hs_descriptor` only from its POST handler.

### Publishing twice, and a test that was pinning our behaviour

The store replaced whatever was held under the same name. tor does not: `cache_store_v3_as_dir`
refuses a descriptor whose revision counter is not **strictly greater** than the cached one. Putting
three sequences to a real HSDir settled it in one run —

| uploaded | tor |
|---|---|
| revision 42, then 43 | both stored, 43 served |
| revision 43, then 42 | the second **refused**, 43 still served |
| revision 42, then 42 | the second **refused** |

The third row is the one with teeth. An unchanged descriptor uploaded twice is a **400**, not a
no-op 200 — and `dird.test.ts` asserted 200 until the sequence was put to a real cache. That case had
been pinning our behaviour rather than tor's, which is the failure mode a home-made oracle always
has: it agrees with whatever it was written against.

The failure the rule prevents is the quiet one. An older descriptor arriving late — a retry, a replay,
a service that lost track of its own state — would otherwise undo the most recent publication, and
every log line on both sides would say it published.

Two things this needed that are worth recording. The second document has to be **generated**, not
edited: the revision counter sits inside the span the signature covers *and* is mixed into the key
derivation for both encrypted layers, so two revisions of one descriptor differ in their ciphertexts
as well as in that line. And the probe now names **which** uploaded file an HSDir would serve, because
every revision of one service's descriptor is exactly the same length — a byte count cannot tell "it
kept the new one" from "it kept the old one".

The held counter is read back out of the stored document rather than kept in a parallel array. The
array would be a second copy of a number that is already in the bytes, and the two drifting would
present as a directory refusing an upload for being older than a descriptor it is not holding.

Of five planted faults one survived: a lookup that ignored the name. Harmless with one service stored,
and wrong the moment a directory holds two — revision counters are per-service sequence numbers, not a
clock, so a new service's first upload would be refused whenever some other service happened to be
further along. **A store with one entry cannot test a lookup**, and every test here had one entry.

### A fixture of one, and the two things it could not say

The descriptor build lived inline in `genhsdesc.wac`'s `main`, so a descriptor could only ever be
built one way with one set of keys. A service cannot use that: its introduction points are its own,
its blinded key changes when the time period rolls over, and its revision counter increments. So the
build is a function now, and the generator is a caller.

**The extraction was checked by regenerating the committed vector and diffing all 33 fields.** That
check earned its keep on the first run. Reconstructing the inner layer's salt from context gave
`(i * 7 + 5)` where the original was `(i * 29 + 5)`, and the only symptom was five changed fields.
Nothing else would have caught it: every test reads the committed vector rather than regenerating it,
so a refactor judged by "it compiles and the suite is green" would have shipped a different
descriptor and only the next regeneration would have shown it.

Then the point of having a function: **inputs the fixture cannot reach.** One service, one
introduction point, one time period says nothing about a builder that quietly ignores everything past
the first introduction point — that builder reproduces the fixture byte for byte. Three variants now
go to both oracles:

| variant | HSDir | client decoder |
|---|---|---|
| two introduction points | filed, identical | `intro_points: 2` |
| three introduction points | filed, identical | `intro_points: 3` |
| the next time period | filed **under a different name** | `intro_points: 1` |

The wac tests take what tor cannot see from outside. The inner plaintext grows by the *same amount*
per introduction point — 682, 1346, 2010 — so a dropped one is a step of the wrong size rather than no
step at all; and the outer layer stays padded to one ten-thousand-byte block regardless, which is the
entire reason that padding exists. How many introduction points a service runs is visible in the inner
length and must not be visible in the outer one.

Of seven planted faults, six were caught and the survivor was the one this package keeps being caught
by: **a certificate signed by the descriptor signing key rather than the blinded secret.** It decodes
perfectly for anyone who does not know the identity key, and every structural assertion passes on it.
The fix is not another assertion about shape — it is to run the built document through
`hsstore.wac`'s `checkForPublication`, which verifies the certificate against the blinded key the
certificate carries. Builder and directory were each pinned against tor and never against each other,
which is the seam this project keeps rediscovering; they are joined now.

### A client fetches one descriptor; a service publishes two

`consensusTimePeriod` answers the *client's* question — which period to fetch for — and it had been
standing in for the service's, which is a different question with a different answer. A service
publishes **two** descriptors, under consecutive time periods with *different* shared random values,
to two different sets of directories. That is not redundancy. It is what keeps a service reachable
across the moment the ring rotates, when some clients have moved to the new period and some have not.

tor's rule is `node_set_hsdir_index` in `nodelist.c`, and it has two halves that are easy to conflate:

- **which pair of periods** depends on where the consensus sits between a new time period and a new
  SRV — `hs_in_period_between_tp_and_srv`, computable from the consensus alone;
- **which SRV goes with each** depends on nothing at all. The older descriptor always takes
  `shared-rand-previous-value` and the newer one `shared-rand-current-value`. tor states this in one
  line that reads like a comment rather than a rule.

The oracle is not a set of parameters. `hsdir_vectors.json` records two uploads a real tor service
made against a real consensus, each with the period and the SRV tor chose for it:

| | period | SRV |
|---|---|---|
| `store_first` | 3720629 | previous |
| `store_second` | 3720630 | current |

Given that consensus we now choose the same two. And that consensus is in the marked stretch, so the
first descriptor is for the period that is **ending** — the case a service that ignored the predicate
would get wrong while every other check passed.

Of eight planted faults, six were caught. Both survivors were in the same arithmetic — the start of
the next time period — and both survived for the same reason: they *lower* that boundary, and the
captured consensus is already past it, so the predicate stays true either way. A synthesised consensus
at 04:00:00, the start of a protocol run and the branch the capture never reaches, tells them apart.

That is the third time this week the same shape has cost a real gap: **one fixture reaches one side of
a boundary.** The padding round-down needed an input one byte over a block; the revision-counter
lookup needed a store with two entries; this needed a consensus on the other side of a period start.
A fixture captured from a live network is the strongest kind of oracle for what it covers, and it
covers exactly one point.

### The ingredients were all pinned; the recipe was not

Every ring test in this package was handed the shared random value and the time period as *inputs*.
A service has neither. It has a consensus, and everything else is a derivation — which two periods,
which SRV goes with each, which directories follow. Each of those was pinned against tor separately
and none of them against the others, which is the seam this project keeps rediscovering: pick the
wrong SRV for a period and every ingredient is still individually correct, and only the plan is wrong.

`servicePlan` is the composition, and the check is that from the consensus in `hsdir_vectors.json` it
reaches exactly the directories a real tor service uploaded to — both descriptors, both directory
sets, membership in both directions.

Two things it makes explicit that a smaller return type would have hidden:

- **The SRV is a field of the result.** Nothing downstream reveals which value was used: two plans
  that chose differently produce different directories, and a directory list does not say which value
  produced it. A service that fell back to the disaster SRV while the consensus carried a real one
  would be indistinguishable from one that did not — until no client could find it.
- **The disaster SRV is a documented fallback, not an error.** A network whose authorities have not
  agreed on a value still has to work, and every party computes the same substitute from the period
  alone, so they still agree about the ring. Refusing there would take a service offline for a
  condition the protocol expects. Tested both ways: the substitute when the consensus carries nothing,
  and the real value when it does.

The blinded keys stay a parameter rather than being derived inside. Deriving them needs the identity
key, and a function that takes an identity key to answer a question about *directories* is one that
will eventually be handed a secret it did not need.

Eight faults planted, eight caught — the first clean sweep in this area, which is what a composition
test buys once its ingredients are already trustworthy.

### A rejection is not a surprise, and a replay is not a client

Two rules from the same afternoon, both about reading an answer correctly rather than computing one.

**The upload.** `fetchOverCircuit` already had the cell loop an upload needs, so it became
`requestOverCircuit` — send bytes, get a `Response` — with the GET as a thin wrapper. The loop is
where SENDME accounting, DESTROY handling and stream teardown live; a second copy would be a second
place for those to be got subtly differently.

Reading the reply, tor's `handle_response_upload_hsdesc` separates three outcomes where two would seem
enough. **400** means this directory read the descriptor and refused it — every other directory will
refuse the same bytes, so retrying is the same failure repeated rather than a recovery. **Anything
else** says nothing about the descriptor. Collapsing them is what turns a signing bug into an
intermittent outage: the service retries around the ring, each directory refusing for the same reason,
and the log shows eight failures against eight directories instead of one bad document. So one
rejection indicts the descriptor even when seven directories accepted it — they all read the same
bytes.

**The replay.** A service answers an INTRODUCE2 by building a rendezvous circuit. tor keeps two caches
and *where each is checked* is as much the rule as what it holds: the ENCRYPTED section against the
introduction point's cache **before** the ntor keys and the MAC, so a replay costs one SHA-256 rather
than a handshake; the REND_COOKIE against the service's cache **after** the parse. tor's comment on
the second is the interesting one — it is usually not an attack. A client whose introduction circuit
timed out resends the same cookie, and the service is already building that circuit.

Their horizons differ for the same reason: a captured cell is as replayable next month, so that cache
never forgets; a cookie an hour later is a new attempt, so that one forgets after five minutes.

### The check that could not live at any call site

Eight faults planted on the replay cache, seven caught. The survivor was a comparison **truncated to
four bytes of a thirty-two-byte digest** — and no test that feeds real inputs can catch it, because
constructing two values whose digests share a prefix is exactly the work the digest exists to prevent.

That is a different kind of gap from the ones this document keeps recording. It is not a missing case;
it is a property that is unreachable from where the calls are made.

So the comparison stopped being private. There were already **four** copies of that loop —
`crypto/aead`, `crypto/aesgcm`, `tor/hsservice` — and the fifth about to be written in `hsreplay` was
not even constant-time, because a replay cache does not look like somewhere timing matters. It is: the
digests are of ciphertext an attacker chose. `crypto/src/ct.wac` now holds `ctEqual` and `ctEqualN`,
all four callers use them, and its own test places the difference at each of the thirty-two positions
in turn. The check that could not live at any call site lives once, and every caller inherits it.

Seven faults planted there, seven caught, the truncation among them.

A smaller thing worth keeping: the replay cache's own test found a trap. A zero-capacity cache fell
through to the eviction path and indexed an empty array. It remembers nothing now — a bad
configuration but a coherent one, and not worth crashing a service over.

### Rotation is a security property, and a comment in tor that is wrong

An introduction point can count the cells it forwards. A service that kept one forever would let it
accumulate an unbounded record of that service's traffic; a service that rotated on a fixed schedule
would be identifiable by the schedule. So tor draws *both* limits and rotates on whichever arrives
first — a busy service on the count, a quiet one on the clock:

    introduce2_max = rand[16384, 32768)
    time_to_expire = now + rand[18h, 24h)

**Both upper bounds are exclusive, and tor's own comment says otherwise.** `crypto_rand_int_range` is
documented as returning a value "between 0 and (max - min) inclusive", which reads as `[min, max]`. It
calls `crypto_rand_uint(max - min)`, which returns `0 .. limit-1`. An introduction point therefore
never lasts a full twenty-four hours and never forwards 32768 cells. Believing the comment puts both
bounds one out, and nothing except a test sitting on the boundary would ever show it — so both
boundaries are tested. That is the same shape as the padding round-down, the one-entry store and the
one-sided consensus: **the documentation of a range is not the range.**

The other rule worth having is an ordering. `should_remove_intro_point` checks for an existing circuit
*before* acting on the retry count, because a circuit may have opened at the previous scheduled
attempt. A service that counted retries alone would tear down an introduction point that had just come
up — a race the counter cannot see from the inside. Expiry and falling out of the consensus outrank
the circuit; the retry count does not. Reordering those two checks is a planted fault, and it is
caught.

The randomness is a parameter, for the reason the descriptor's salts are, and for one more: the
rejection sampling belongs at the source. `crypto_rand_uint` loops to avoid the modulo bias, and a
caller pushing a raw byte through a `%` at this end would reintroduce exactly that bias with nothing
here able to notice.

Nine faults planted, nine caught.

### Everything here is a steady state, and the interesting bugs are in the transitions

Worth writing down as a gap rather than leaving as an impression: **every property this stack has
pinned is a steady state.** Given this consensus, choose these directories. Given these bytes, accept
or refuse. Given this period, this name. Each is a pure function tested against a value C tor produced,
and that has found real defects all week.

What none of them touches is *change over time*, because each transition costs hours of wall clock:

| transition | how long it takes to observe |
|---|---|
| publish, the time period rolls, republish, a client still finds the service | 24h (8 minutes on chutney) |
| an introduction point expiring while an INTRODUCE2 is in flight | 18–24h, drawn |
| a consensus expiring mid-circuit; `refreshAt` firing at all | ~1h |
| a revision counter across a service restart | a restart, plus a publish interval |

`serviceStorePeriods` is the sharpest example. It exists *entirely* to decide what to do either side of
a period boundary, and it has only ever been tested at two frozen instants — the captured consensus and
a synthesised one. The boundary itself, which is the thing it is for, has never been crossed in a test.

There is also a quieter cost. `hsdir_vectors.json` records `periodLength: 8` **minutes** because chutney
shrinks the voting interval to twenty seconds to make rotation observable; production is 1440. So
`timePeriodLength(testingNetwork: true, …)` is the branch under test and the production branch has never
met a live network. That is not a coverage gap that patience would close — it is a *different
configuration*, tested in place of the real one.

**design/0001's D13 is what would close both.** Virtual time — a clock the scheduler advances when
nothing is runnable, rather than a clock it merely owns — turns "24 hours" into "200ms" and removes the
reason to shrink the voting interval at all. The first demonstration worth building is stated there:
publish a descriptor, cross a period boundary in simulated time, fetch it as a client.

With the caveat D13 also states, which belongs here more than there: **a closed-world simulation is a
symmetric oracle**, and this document is a record of that trap being fallen into repeatedly. Every
defect found this week came from C tor and none would have survived contact with a simulator that only
ran our own code faster. Virtual time is for the transitions; C tor stays the oracle for the steps.

### The auth key was the attacker's, and the test for it passed

`parseIntroduce2` read the AUTH_KEY field out of the INTRODUCE2 cell and derived the MAC key from it.
tor does not: `hs_circuit.c` sets `data.auth_pk` from the introduction point's **own** keypair, and
`hs_cell.c` never compares the cell's field against it.

The consequence is that the auth key contributed nothing to the check it is part of. A client names
any key it likes, we derive the MAC key from that same wrong value, the MAC verifies, and the cell is
accepted where tor would reject it — with the field that says *which introduction point this arrived
through* saying whatever the sender preferred.

**The test for exactly this passed the whole time, and passed for the wrong reason.** It read:

    t.isTrue(!parseIntroduce2(flipAt(cell, 25), secret, subcred).ok, "a changed auth key is refused");

Flipping a byte *tampers* the cell, and the MAC covers the field, so it fails whether the derivation
key came from the cell or from us. Tampering and a self-consistent forgery are different attacks and
only the first was ever tried. The case that separates them needs no construction at all — tor's own
cell, unmodified, offered at an introduction point whose auth key is a different one — and it is the
kind of case that only gets written once the parameter exists to express it.

That is the same shape as three other findings this week and worth naming as a class: **a test can
exercise the right line for the wrong reason.** The padding boundary, the one-entry store, the
one-sided consensus and now this were all covered by an assertion that could not have failed the way
the code was wrong.

**What was deliberately not done.** The cell's field is not compared against ours. tor does not
compare it, so a client that MACs with the right key and writes anything in the field is a cell tor
accepts — and refusing it here would be *stricter than the network*, which this document has already
recorded twice as its own failure mode. There is nothing to gain either: a correct MAC means the
sender holds the descriptor, which is every legitimate client. The security property is not the
comparison. It is that the key feeding the derivation is ours.

### The fixture named a rendezvous point tor would have declined to use

`handleIntroduce2` is the composition: cell in, RENDEZVOUS1 out, in the sequence
`hs_circ_handle_introduce2` uses. Every piece was already pinned, so the only thing left to get wrong
was the order — and three of the placements are load-bearing in ways the step itself does not show.

**Each one is observable if the input is chosen for it**, which is the difference between testing an
order and asserting it in a comment:

- the ENCRYPTED section is checked against the introduction point's replay cache *before* the MAC.
  Replay the cell with a **wrong encryption secret**: parse-first would answer `UNREADABLE`,
  replay-first answers `REPLAYED`. That is the proof no handshake was computed, and it is the whole
  reason a replayed cell costs a SHA-256 rather than a curve25519 operation.
- a cell that could not be read is still remembered, so the second copy of a garbage cell is not even
  parsed.
- the cookie is checked *after* the parse, and its cache belongs to the service while the cell cache
  belongs to the introduction point. A fresh cell cache with a shared cookie cache is a client
  retrying through a different introduction point — tor's own stated case, and one that only exists
  because the two scopes differ.

**The fixture had to be fixed before any of it could be tested, and the way it was wrong is the
lesson.** Its cells carried a single IPv4 link specifier. That is enough to test a *parser*, because
the list is opaque to one — and it names a rendezvous point **tor itself would decline to use**, since
`hs_get_extend_info_from_lspecs` requires the legacy identity. A fixture adequate for the question it
was built for was inadequate for the next question, and nothing announced the difference.

Four of five new cases failed against it. The fifth passed *for the wrong reason*: "a loopback
rendezvous point is refused on a real network" passed because every case was being refused. That is
the fifth instance this week of a test exercising the right line for the wrong reason, and the second
where the passing test was the misleading one.

Twelve faults planted, nine caught. The three survivors were a single gap — the cell's length and its
cookie were asserted, its 64-byte handshake was not — so swapping AUTH for the key seed, or sending
the client's ephemeral key where ours belongs, went unnoticed. Both halves are recomputable in the
test because each is pinned separately, which makes checking the **assembly** possible without a
captured RENDEZVOUS1 to compare against.
