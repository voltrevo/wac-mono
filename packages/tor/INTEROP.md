# The interop matrix

Design 0002 step 7: *each component, in both directions, against C tor*. Not a step so much as the
thing steps 2–6 each contribute a row to, and the place a regression would show — because a
regression in one component is invisible until something collects them.

Last reviewed **2026-08-07**, against `tor 0.4.7.13` (`~/tor-build/torproject-tor-c8d2b17`).

## What the columns mean

**Direction matters more than the component does.** Almost everything here is easier to write than to
read, and a package that only ever *writes* what tor reads has tested half of itself. So each
component gets both:

- **we → tor** — tor parsed, verified or accepted something we produced.
- **tor → we** — we parsed, verified or accepted something tor produced.

And three strengths, which design 0002 already distinguishes and this table keeps apart because the
difference is the whole point:

| | meaning |
| --- | --- |
| **pinned** | pure functions against bytes C tor wrote, or against C tor's own parser called directly. Committed vectors, so the suite checks it on every run with no tor present. |
| **live** | a C tor process was on the other side of a socket and the thing worked. |
| **ours only** | our code on both sides. Real evidence that the pieces compose; no evidence that either agrees with tor. Recorded as such rather than counted as green. |
| **—** | not done. |

## The matrix

| component | we → tor | tor → we |
| --- | --- | --- |
| RSA signing (`rsagen`, `rsaSignPkcs1`) | **pinned** — byte-identical to node's, and OpenSSL accepts the keys | n/a |
| X.509 (`derwrite`, `x509gen`) | **pinned** — OpenSSL verifies what we generate | **live** — our TLS client reads OpenSSL's and rustls's |
| TLS 1.3 (`packages/tls`) | **live** — OpenSSL and rustls complete a handshake with our server | **live** — our client completes one with both, and with C tor's TLS |
| link handshake (`relaylink`) | **live** — a C tor completes a link handshake with our relay | **live** — our client completes one with a C tor relay |
| CREATE2 / EXTEND2 (`relaycircuit`) | **live** — a C tor builds a three-hop circuit through our relays | **live** — our client builds circuits through C tor relays |
| ntor (`ntor.wac`) | **pinned** — `test-ntor-cl` derives the same 92 bytes, KH included | **pinned** — same vector, other direction |
| streams (`RELAY_BEGIN`, data) | **live** — `stream 5129 open to …:8087`, 5004 bytes byte-identical | **live** — `curl --socks5-hostname` through our client |
| router descriptors (`routerdesc`) | **pinned** — tor's own parser accepts ours | **pinned** — we read tor's, from `capture-routerdesc.py` |
| votes and consensus (`vote`, `consensusgen`) | **live** — a C tor bootstraps from our authority, both flavours | **pinned** — we verify consensuses tor produced |
| microdescriptors (`microdesc`) | **pinned** — accepted by tor's parser | **pinned** — `capture-microdesc.py` |
| onion addresses, blinding (`onionaddr`, `hsblind`) | n/a | **pinned** — `capture-blind.py`, tor's `ed25519_keypair_blind` |
| HSDir hash ring (`hsdir`) | n/a | **pinned** — the directories a real service uploaded to, from its own logs |
| descriptors (`hsdescbuild`, `hsdesc`) | **pinned** — `hs_desc_decode_descriptor` accepts ours, three variants | **pinned** — we decrypt descriptors tor built |
| descriptor publication (`hsstore`, `dirstep`) | **pinned** — `hs_cache_store_as_dir` files ours under the name we compute | **pinned** — we refuse every descriptor tor refuses |
| ESTABLISH_INTRO (`hsservice`) | **pinned** — tor's parser accepts ours | **pinned** — we accept tor's and refuse its seven mutations |
| INTRODUCE1/2 (`hsintro`, `hsintroduce`) | **pinned** — tor built the cells we parse | **pinned** — same cells, our parser |
| hs-ntor (`hsntor`) | **pinned** — both halves against `capture-hsntor.py` | **pinned** — same |
| introduction point, relay side (`introrelay`) | **live** — a C tor client's INTRODUCE1 relayed to our service | **live** — same exchange |
| rendezvous point, relay side (`rendrelay`) | **live** — a C tor client established a cookie here and our service joined it | **live** — same exchange |
| onion service hosting (`hsserviced`) | **live** — `curl --socks5-hostname` through C tor returned our page | n/a |

## Step 6's own condition, met

**"Done when a C tor client reaches a service we host."** On 2026-08-07:

    $ curl --socks5-hostname 127.0.0.1:9250 http://kybekhk…qqd.onion/
    hello from behind an onion

`tor 0.4.7.13`, bootstrapped from a consensus our authority signed, through our relays, to a service
our code hosts. The three onion-service rows above moved from `ours only` to `live` on that run, and
each party logged its own side of it:

    ctor:    Bootstrapped 100% (done)
    relay3:  circuit -1250964417 is an introduction point
    relay3:  an introduction, status 0
    relay2:  circuit -305703914 is waiting at a rendezvous
    relay2:  rendezvous joined: circuit -810529448 to -305703914
    service: rendezvous joined, the client is hop 4
    service: served 92 bytes to a client

Three days earlier this table would have read `ours only` for all three, and the day before that the
relay roles did not exist.

### Two things that run taught, which no test had

**A C tor client will not use a DirPort.** It prefers a tunnelled directory connection even when the
fetch is direct, so it dials the *ORPort* named in the `DirAuthority` line and speaks the link
protocol there. A `dird` serving only a DirPort is unreachable to it. What works is pointing the
authority line at something that answers BEGIN_DIR — `relayd -C -K -D` does — and letting the two
identities differ, which tor allows and which is the point of the line's shape:

    DirAuthority wacauth orport=5551 no-v2 v3ident=<authority> 127.0.0.1:7000 <relay1 fingerprint>

`v3ident` is whose signature to trust on the consensus; the trailing fingerprint is whose TLS identity
to expect on the wire. They are different keys and different questions.

**A service that always publishes revision 1 can never republish.** An HSDir replaces a descriptor
only on a strictly greater revision counter, so restarting `hsserviced` against a network it had
already published to produced *wacrelay2 refused the descriptor; it is the document that is wrong, not
the directory* — the rule working and the caller wrong. It now counts seconds into the time period,
which is what tor counts.

**Where we differ from tor, and it is a disclosure:** tor encrypts that counter with an
order-preserving cipher, so the ordering survives and the value does not. We publish it in the clear,
which tells anyone who fetches a descriptor when the service last published.

## The limit that remains

`network.wac` **cannot start a C tor** — `Cli.spawn` takes a worker bundle and this world has no
capability for running an arbitrary binary. So the C half of every live row above is run by hand and
is not in the suite. That is deliberate and it is the reason these rows can rot without anything going
red.

## Regressions this table is meant to catch

A row moving from **live** or **pinned** back to **ours only** is the event worth noticing, and it can
happen without any test failing: delete a captured vector and the differential quietly becomes a
round trip through our own code. Two guards exist for that and both were added after being needed —
the harnesses assert their vectors came from tor (`if (!v.source.includes("hs_cache_store_as_dir"))`)
and that every control was refused, so a fixture that stopped being tor's fails loudly rather than
passing vacuously.
