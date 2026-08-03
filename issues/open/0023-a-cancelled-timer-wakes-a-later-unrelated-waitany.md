# 0023 — a cancelled timer wakes a later, unrelated `waitAny`

- **Status:** open
- **Reported by:** agent-c
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

## What happens

A `sleepMillis` ticket that is cancelled still fires at its original deadline, and the
completion wakes a `waitAny` issued **later** over a **different** set of tickets. That
`waitAny` returns an index into its own list, so the caller is told a ticket settled which
has not.

The visible effect is a timeout firing early. A 30-second bound expires after 15 seconds,
because a 15-second timer was cancelled earlier in the program.

## Reproduction

Needs a peer that accepts and then says nothing:

```ts
const l = Deno.listen({ port: 5999, hostname: "127.0.0.1" });
for await (const c of l) { void c; }
```

Then, as a platform application with `--allow-net`:

```wac
Pending<Socket> dial = cli.connect("127.0.0.1", 5999);
Pending<i64> ct = core.sleepMillis(15000);
cli.waitAny(i32[](dial.id, ct.id));      // the dial wins
ct.cancel();                             // the 15s timer is cancelled
Socket s = dial.wait();
cli.send(s.handle, "hello".toBytes()).wait();

Pending<u8[]> read = cli.recv(s.handle); // nothing will ever arrive
Pending<i64> rt = core.sleepMillis(30000);
i32 w = cli.waitAny(i32[](read.id, rt.id));
```

Observed:

```
dial id 0, connect-timer id 1
read id 12, read-timer id 5  (a fresh id)
index 1 after 15003ms, asked 30000
```

Expected: index 1 after about 30000ms.

**It is not id recycling.** The read timer was given id 5, not the cancelled timer's id 1 —
that was checked precisely because it was the first explanation that came to mind. The
15-second deadline belongs to a ticket that is not in the list at all.

## What does *not* reproduce it

Timers alone are fine, which is why this took a while to corner:

```wac
Pending<i64> winner = core.sleepMillis(500);
Pending<i64> loser = core.sleepMillis(5000);
cli.waitAny(i32[](winner.id, loser.id));   // winner
winner.wait();
loser.cancel();
core.sleepMillis(20000);                   // takes the full 20000ms — correct
```

So does everything else I measured while looking for it, all correct:

- `sleepMillis` under `.wait()` at 50, 200, 1000, 3000ms — within 15ms
- `sleepMillis` under `waitAny` at 1000, 5000, 20000, 30000, 40000ms — within 35ms
- `waitAny` index reporting with the short ticket first *and* second
- cancelling a timer that never entered a `waitAny`, then timing a longer one

The difference in the failing case is slot churn: a connect, a send and a recv between the
cancel and the later wait. Whatever is wrong is about a completion arriving for a slot
nobody is waiting on, not about the timer itself.

## Why it matters

Not just a late answer — an **early** one. A timeout that fires at half its interval will
break a connection that was about to succeed, and the caller cannot tell that from a peer
that really did go silent. In `packages/tor` this is a client abandoning a healthy relay;
in the SOCKS proxy that `waitAny` was added to make possible, it would be a proxy dropping
live connections at intervals set by whatever timer was cancelled most recently.

`Pending.cancel` documents itself as "detach, not abort" for the *work*, which is
understood and fine. This is different: the ticket is gone, and its completion still lands
on somebody.

## Where it bit

`packages/tor/src/app.wac` bounds every dial at 15s and every read at 30s, which is the
whole point of 0018. With this, a silent relay is reported after 15 seconds rather than 30,
and — worse — a *responsive* relay taking longer than 15s to answer would be dropped.

The timeouts are left as written rather than tuned around this: they are correct against
the documented contract, and picking values that hide the bug would make it somebody else's
puzzle later.
