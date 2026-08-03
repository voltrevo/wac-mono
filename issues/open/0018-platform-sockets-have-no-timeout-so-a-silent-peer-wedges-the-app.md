# 0018 — platform sockets have no timeout, so a silent peer wedges the application

- **Status:** open
- **Reported by:** agent-c
- **Date:** 2026-08-03
- **Kind:** missing feature
- **Symptom:** not implemented

## What is missing

Nothing bounds how long a socket capability may take. `connect`, `accept`, `recv` and `send`
each park the worker until the host answers, and the host waits on the network for as long
as the network takes.

So a peer that completes a TCP handshake and then says nothing stops the application
permanently. Not slowly — permanently, with no error, no log line and no way for the
application to notice. `Pending.isDone()` never becomes true and `.wait()` never returns.

## Why it matters beyond robustness

For a plain client this is a hang. For anything privacy-sensitive it is worse than that:
a peer that can hold a connection open indefinitely can keep an application pinned to
itself, which is a position an attacker will pay for. Tor's own client bounds circuit
construction adaptively (its "circuit build timeout") partly for exactly this reason —
a connection that is unusually slow is both a performance problem and a signal.

It also cannot be worked around above the boundary. An application has no clock it can run
*while parked*, and no way to abandon a call it has already entered:

- `Pending.cancel()` says what it is — "Detach, not abort. The host may already be inside
  the work and generally cannot be interrupted." It discards an answer; it does not free
  the worker, which is not parked on the ticket but on the shared buffer.
- Issuing the call and polling `isDone()` instead of waiting would need a second thread to
  do the timing, and "concurrency means more instances".

So this is a capability-shaped problem and the fix has to be on the platform side.

## Shape

A deadline on the call is the smallest thing that would work, and keeps the ticket model:

```wac
fn[Pending<u8[]>(i32, i32)] recvWithin;   // handle, milliseconds
```

or a deadline carried on the ticket rather than duplicated per capability. Either way the
answer needs to distinguish *timed out* from *peer closed*, because `recv` already uses an
empty array for "closed" and an application must be able to tell "they hung up" from "they
are still there and silent" — the first ends a stream, the second ends a relationship.

## Where it bit

`packages/tor` is being ported from a TypeScript host onto this world. Its client talks to
relays chosen from a public directory, which is to say to strangers, and it currently has
no timeouts either — the TypeScript version inherited the same gap from `Deno.Conn` reads.
The port is going ahead without a workaround, because a spin loop or a second instance
would be a worse thing to own than the wait.
