# 0018 — platform sockets have no timeout, so a silent peer wedges the application

- **Status:** closed 2026-08-03, fixed by `core.sleepMillis` — a ticket that settles on time
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

## Fixed: a timer ticket, not a timeout argument (agent-a, 2026-08-03)

`core.sleepMillis(ms)` returns `Pending<i64>` settling when the time has passed, resolving
to the monotonic nanoseconds at which it did. `waitAny` does the rest:

```wac
Pending<u8[]> r = cli.recv(h);
Pending<i64> t = core.sleepMillis(5000);
if (cli.waitAny(i32[](r.id, t.id)) == 1) { /* five seconds of silence */ }
```

Taking the `recvWithin` suggestion instead would have needed a variant per capability, and
`connect` and `accept` want one just as much as `recv` does. A ticket that settles on time
is the same idea one level down: nothing about it is socket-specific, so it bounds
`readFile` or a child's `exitCode` unchanged, and it took no change to the bridge because
the ring already had `waitAny`.

**Timed out and peer closed are distinguished by which index `waitAny` returns**, so the
empty-array-means-closed convention did not have to grow a third case — the answer to
"which of these happened" is structural rather than encoded in the value.

Portable: `Core`, not `Cli`, beside `nowMillis` and `monotonicNanos`. It is not authority —
a clock is not a capability anyone grants — and all three worlds have `setTimeout`, so a
`Core`-only application can use it too, where `.wait()` on one is just a sleep.

`example/patience.wac` and `test/timeout.test.ts` cover it: a peer that accepts and stays
silent now takes 706ms to give up instead of running until killed.

### The part worth reading before using it

A timeout is a decision the *waiter* makes. It does not reach the read the host has already
entered, and it does not collect the tickets `waitAny` did not pick. That second one is a
leak I hit while writing the example, and it presents identically to the bug this issue is
about — a permanent silent park:

- **Bind the timer.** `core.sleepMillis(ms).id` inline in the `waitAny` list cannot be
  cancelled afterwards, and it is the shape that reads most naturally.
- **Cancel the loser every round.** `waitAny` collects nothing. A fired timer nobody
  cancels holds a ring slot for good; four of those and the next call has nowhere to go.
- **To wait longer, re-wait the same ticket.** A second `recv` on a handle whose first is
  outstanding is two reads on one socket with no defined order.
- **Giving up needs both** `cancel` (discard the answer) and `closeSocket` (make the read
  finish, which is what actually returns the slot).

Because that leak used to park the next `submit` forever, `claim` now checks for it: every
slot in `ST_READY` means every slot holds an answer only the submitting thread can free,
and that thread is the one asking — provably stuck, not backpressure. It raises `all 4 call
slots hold answers that were never taken` and names the fix, since the symptom otherwise
points at whatever innocent call ran out of slots rather than at the ticket abandoned
several rounds earlier. That is arguably the more valuable half of this change: it converts
a class of silent hang into an error, which is what the issue was really complaining about.

### What is still true

- **`cancel` cannot abort a call the host has entered.** `Deno.connect` and `Conn.read`
  take no `AbortSignal`, so for a read the mechanism is closing the handle. A timed-out
  `connect` has no handle yet, so its slot comes back only when the host's own attempt
  finishes — worth knowing before retrying connects in a loop against dead peers, since
  four in flight is the whole ring.
- **Adoption is the callers' business.** `packages/tor` and `packages/box`'s socket applets
  now have what they need; neither has been changed here.
