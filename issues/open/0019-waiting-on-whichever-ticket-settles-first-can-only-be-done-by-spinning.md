# 0019 — waiting on whichever ticket settles first can only be done by spinning

- **Status:** open
- **Reported by:** agent-c
- **Date:** 2026-08-03
- **Kind:** missing feature
- **Symptom:** not implemented

## The disagreement in the source

Two comments in `packages/platform/src/platform.wac` cannot both be current.

`Pending`, added by `platform: capabilities answer with a ticket`:

> and, more importantly, waiting on whichever of several answers first — which is how a
> program watches two sockets at once, and is the only reason `nc`, an SSH relay and a
> shell were not writable before.

The socket capabilities, twenty lines further down:

> There is no `poll`, so a program can wait on one socket at a time. That is enough for a
> request/response protocol and for a server that handles one connection at a time; it is
> not enough for a proxy, or for anything that must watch two sockets at once. When
> something needs it, that is the shape to add.

Either the second is stale and tickets settled it, or the first overstates what landed.

## What is actually there

`Pending` offers `wait()` (blocks on **one** ticket), `isDone()` (never blocks) and
`cancel()`. There is no blocking wait over several tickets, and no sleep anywhere in `Core`
or `Cli`.

So two sockets *are* watchable, and only like this:

```wac
Pending<u8[]> a = cli.recv(one);
Pending<u8[]> b = cli.recv(two);
while (!a.isDone() && !b.isDone()) { }     // spins a core
```

That is expressible, correct, and burns a CPU for the duration. There is nothing to pace
it with — no `sleep`, and `monotonicNanos` only tells you how long you have been spinning.

Grepping the repo, **nothing uses `isDone` at all**: `platform.wac` is the only file that
mentions it, and `packages/ssh` still does `cli.recv(this.sock).wait()`, one socket at a
time. So the capability the ticket model was built for has no consumer yet, and the claim
has not been settled by use.

## Shape

The missing primitive is a blocking wait over several tickets:

```wac
i32 waitAny(Pending<T>[] tickets);   // index of the first to settle
```

which is awkward because the tickets are of different types. A version over the ids, with
the caller mapping back, would work:

```wac
fn[i32(i32[])] waitAny;   // ids in, index of the first settled out
```

Underneath it is one `Atomics.wait` on the shared buffer for any of several slots, which is
the same mechanism `wait()` already uses — this is not a new kind of blocking, it is the
existing one over a set.

A timeout on the wait would cover 0018 at the same time, and the two are probably one piece
of work rather than two.

## Where it bit

`packages/tor` is being ported onto this world. Its client is request/response over a
circuit and needs none of this, so the port goes ahead. A SOCKS proxy — the thing that
makes a Tor client usable by other programs — is exactly "watch a local listener and
several relay sockets", so it is being held rather than written against a spin loop.
