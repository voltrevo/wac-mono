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
| introduction point, relay side (`introrelay`) | **ours only** | **ours only** |
| rendezvous point, relay side (`rendrelay`) | **ours only** | **ours only** |
| onion service hosting (`hsserviced`) | **—** | **ours only** — our client fetched a page from it |

## The row that is not green, and why it is the important one

**Step 6's own condition is "done when a C tor client reaches a service we host", and that has not
happened.** What happened on 2026-08-07 is that *our* client reached it:

    joined: the service is hop 4
    hello from behind an onion

That meets the deliverable's condition — a network with no C in it, a service published on it, a page
fetched through a three-hop circuit — and it is not the same claim. Every seam in that path has our
code on both sides, which is the arrangement design 0002's D1 says proves the least.

It is worth being precise about what it *does* prove, because it is not nothing: every cell along that
path was pinned separately against cells C tor wrote, so the composition is the only new thing being
asserted. The sharpest case is `joined: the service is hop 4` — the client's hs-ntor AUTH check
passed, and the two ends derived that key material from opposite sides of one expansion, each pinned
against tor's own vectors.

But *pinned on both ends* and *live* are different rows, and this table exists so that difference is
visible without reading three thousand lines of design notes. **This matrix's first act was to catch
its own author marking step 6 done against the wrong condition.**

## What would turn the last three rows green

A C tor client fetching from `hsserviced`, which needs a C tor configured with our authority — the
same shape as the existing relay and directory interop runs, which are shell scripts rather than suite
tests because `Cli.spawn` takes a worker bundle and this world has no capability for running an
arbitrary binary. That is a deliberate limit, recorded here rather than left as an omission:

- `network.wac` **cannot start a C tor**, so the C half of every live row is run by hand.
- The relay and authority rows were witnessed that way and are recorded as live on that basis.
- The onion-service rows have not been, and are recorded as `ours only` on that basis.

## Regressions this table is meant to catch

A row moving from **live** or **pinned** back to **ours only** is the event worth noticing, and it can
happen without any test failing: delete a captured vector and the differential quietly becomes a
round trip through our own code. Two guards exist for that and both were added after being needed —
the harnesses assert their vectors came from tor (`if (!v.source.includes("hs_cache_store_as_dir"))`)
and that every control was refused, so a fixture that stopped being tor's fails loudly rather than
passing vacuously.
