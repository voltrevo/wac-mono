# 0089 — a relay carries downloads but truncates uploads at about six cells

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b
- **Date:** 2026-08-06
- **Kind:** bug
- **Symptom:** wrong answer

`packages/tor/src/relayd.wac` forwards data from a client to a stream's target correctly for the first
few cells and then closes the stream, reporting `stream N closed by the far end` when the far end has
not closed anything.

Measured twice, on a quiet machine (load 0.19–1.0), with a C tor client and three of our relays:

| direction | size | result |
| --- | --- | --- |
| download | 64 KB, 200 KB, 400 KB, 1 MB | complete, byte-identical |
| download | 8 MB at 100 KB/s (a deliberately slow reader) | complete, byte-identical |
| **upload** | 64 KB | **2,988 and 3,329 bytes delivered on two runs, then the stream closes** |
| **upload** | 1 MB | curl exit 97 |

The control is in the same run: a direct POST of the same 64 KB to the same sink, not through tor,
delivers all 65,536 bytes.

~2,988 and ~3,329 bytes are about six 498-byte cells, and the two runs differing says it is a race
rather than a fixed limit. **See below** — a later run with byte counters suggests those numbers may
belong to a different stream than the one that fails. The second run's relay logs show no circuit failure at all — the first
run's did, which is why it was repeated before anything was concluded.

## The hypothesis below was tested and is **wrong**

`packages/platform/example/writeread.wac` asks the question with no Tor in it: connect to a peer that
never speaks, issue a `recv`, then `send` on the same handle twenty times and poll the read after each.

    writeread: the read is outstanding and the peer is silent, as expected
    writeread: VERDICT still pending after 20 sends (9960 bytes).
               A write does not disturb a read on the same handle.

So the platform is fine and the fault is `relayd`'s. The hypothesis is kept below rather than deleted,
because the reasoning that produced it — the download/upload asymmetry — is still the right shape of
question even though the answer was no.

## What the byte counters then showed

`relayd` now counts bytes each way per stream and says so when a stream closes. With that, the
`stream N closed by the far end` line that started this issue turns out to be **a different stream**:

    stream 56061 closed by the far end after 89 bytes in, 69 bytes out

89 bytes is exactly a curl `GET` request and 69 is exactly the sink's reply, so that stream is the GET
control and it worked perfectly — the close was the sink's own `Connection: close`. The stream that
matters is the next one, and it has *no* closing line at all: it opens and then nothing happens to it.

That changes the shape of the bug. It is not "the relay truncates an upload after six cells" so much
as "the relay opens the stream and then the client's DATA does not arrive, or does not match" — the
earlier partial deliveries (2,988 and 3,329 bytes) were real but came from runs where a different
relay was the exit, so they may not be the same event.

## And then tor's own log moved it again

With the first data cell each way logged, the upload stream never logs one at all — no `RELAY_DATA`
for it reaches the exit, and none arrives with a mismatched stream id either (that would hit the
catch-all). So the body is never sent. tor's log says why it is never sent:

    'connected' received for circid 2293307825 streamid 39711 after 0 seconds.
    exit circ (length 3): …(open) …(open) …(open)
    circuit_mark_for_close_(): Circuit 0 (id: 2) marked for close at circuitlist.c:1677
                               (orig reason: 520, new reason: 0)

520 is `END_CIRC_REASON_FLAG_REMOTE | 8` — the remote flag with `CHANNEL_CLOSED`. **One of our relays
tore the circuit down**, immediately after the second stream on it opened and before any body could
flow. So this is not about forwarding `RELAY_DATA` at all.

The sequence that precedes it is the interesting part, and it is the *second* stream on a reused
circuit:

    stream 39710 open          (the GET control)
    stream 39710 is carrying data from the client
    stream 39710 closed by the far end after 89 bytes in, 69 bytes out
    relay command 3 on stream 39710 (this circuit has no stream)   <- the client's own RELAY_END,
                                                                      arriving after we dropped it
    stream 39711 open          (the upload)
    …nothing…

**Suspects, in order.** The `!inbound.recognized` branch destroys the circuit when a cell does not
authenticate — at an exit that means the running backward/forward digest has gone out of step, and
the most likely place for that is the exchange of two `RELAY_END`s around a stream closing. Second:
whatever `dropCirc` is reached by. Both are `relayd.wac`'s, not the platform's.

## Pinned, reproducible, and one lead left

`ExitNodes <fp>` plus `StrictNodes 1` in the probe's torrc removes tor's random exit choice, and with
it the failing sequence is the same every run:

    stream 55423 open                        (the GET control)
    stream 55423 is carrying data from the client
    stream 55423 closed by the far end after 89 bytes in, 69 bytes out
    relay command 3 on stream 55423 (this circuit has no stream)
    stream 55424 open                        (the upload)
    …nothing…

**The lead is optimistic data.** tor's log for the failing stream says:

    link_apconn_to_circ(): Looks like completed circuit … does allow optimistic data
    connection_ap_handshake_send_begin(): Sending relay cell 0 … to begin stream 55424.
    connection_ap_handshake_send_begin(): Address/port sent, ap socket 16, n_circ_id …
    'connected' received for … streamid 55424 after 0 seconds.
    circuit_mark_for_close_(): … (orig reason: 520)

tor sends the request **immediately after BEGIN, without waiting for CONNECTED**. `relayd` handles a
BEGIN with a blocking `cli.connect(…).wait()`, so those DATA cells arrive while it is parked mid-cell
— which is a case nothing has ever exercised, because a GET's request also arrives that way but is
small enough to sit in one record with the BEGIN. That is where to look next.

**A second, independent defect keeps appearing in the same runs:** `could not reach 127.0.0.1:5557`,
one relay failing to connect to another on a machine with the port open and the peer running. It is
not this bug and it should not be diagnosed as part of it.

**agent-a's scheduler is the tool for the next attempt.** `host/schedule.ts` (commit dc89e43) makes
the host answer one worker at a time in a chosen order — `WAC_SCHED=fifo` for a canonical, diffable
order, `WAC_SCHED=seeded:N` for a reproducible random one. `src/network.wac` already runs the relays
as workers of a single host, so a network stood up through the launcher can be replayed exactly, and a
working run diffed against a failing one. That is a far better instrument than another log line.

**Removing the randomness is still the next step**: tor picks an exit from the three at will, so each
run instruments a different relay, and the runs above each answered a third of the question. A
single-relay path or a pinned exit would let one run answer it. Note also that the machine was at load
4.4 from another agent for these runs, and one earlier run showed genuine relay-to-relay connection
failures, so a quiet box is worth waiting for before drawing the last conclusion.

## A hypothesis, clearly labelled as one — since disproved, see above

The two directions differ in exactly one way:

- a **download** does `recv(streamSock)` and `send(clientSock)` — *different* sockets
- an **upload** does `send(streamSock)` while a `recv(streamSock)` is still outstanding — the *same*
  socket

`relayd` arms one `recv` per stream at BEGIN time and keeps it in the `waitAny` list. On an upload it
then calls `cli.send(k.streamSock, …)` for each arriving DATA cell, with that `recv` still in flight.
The symptom is that the outstanding `recv` settles as `End` shortly after the first burst of sends —
`feedConn` reads that as the far end closing, sends `RELAY_END` to the client and closes the socket.

Nothing in `platform.wac` says a handle may not have a `recv` and a `send` in flight at once, and
nothing in the host code obviously enforces it, so **this is a hypothesis and not a diagnosis.** It
fits the asymmetry and the cell count; it has not been isolated.

## What would settle it

A platform-level test, away from Tor entirely: connect two sockets, issue a `recv` on one, then
`send` on the same handle several times, and see whether the `recv` settles as `End`. That is a dozen
lines against `packages/platform/example/` and it distinguishes "the platform does not allow this"
from "`relayd` mismanages its tickets" without any of the tor stack in the picture.

If the platform is fine, the next suspect is `feedConn`'s stream branch: it re-arms
`k.fromStream = cli.recv(k.streamSock)` *before* checking whether the read that just settled was an
`End`, so a closed socket gets a fresh ticket — harmless on its own, but worth ruling out.

## Why it was not noticed before

Every live test so far has been a download: fetching a consensus, fetching a page, fetching a file.
Design 0002's step 3 is recorded as "a stream carries bytes", and it does — in one direction. The
upload path had never been exercised, which is also why this is filed rather than fixed in passing:
it is a real defect in a program other agents run, and the fix depends on which of the two suspects
above it is.

## Not flow control

This was found while testing whether missing `SENDME` handling breaks large transfers. It does not,
and that is worth recording separately: downloads of 8 MB succeed even with a slow reader, because
tor sends circuit-level SENDMEs unconditionally and applies TCP back-pressure by stopping reads when
its own output buffer fills. The exit's missing window accounting never gets a chance to matter in
that direction. See `design/0002-the-whole-tor-stack.md`.
