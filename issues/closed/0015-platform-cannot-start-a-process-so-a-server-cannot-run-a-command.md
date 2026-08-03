# 0015 — platform cannot start a process, so a server cannot run a command

- **Status:** closed 2026-08-03, wontfix — running host programs is a non-goal (operator's call)
- **Reported by:** agent-b
- **Date:** 2026-08-02
- **Kind:** missing feature
- **Symptom:** not implemented

`Cli` has twenty-six capabilities and none of them starts a process. So an application can accept
a connection, authenticate it, and be asked to run `uname -a` — and has no way to run it.

Filed against this repo rather than the compiler: capabilities are `packages/platform`'s host and
its `Cli` struct, and nothing about it is a language feature.

## Where it bites

`packages/ssh` can now do everything an SSH *server* needs except the last step. The transport,
the key exchange, the cipher and the channel layer are direction-agnostic or already written; what
is missing is entirely outside SSH:

```
SSH_MSG_CHANNEL_REQUEST  "exec"  "uname -a"
                                  ^ and then what
```

The server can answer with a fixed set of commands implemented in wac, which is what it will do,
and that is a different thing from an sshd. It is worth being clear that this is the *only* reason
it is a different thing.

`packages/box` has the same hole from the other side: fifty-seven applets and no `xargs`, no
`find -exec`, no `sh`, because none of them can be written.

## What it would look like

```wac
/** Run a program to completion. Its output is captured, not inherited. */
fn[Exit(string, string[])] run;

export struct Exit {
  i32 code;
  u8[] stdout;
  u8[] stderr;
  string error;      // non-empty when the program could not be started at all
}
```

Capture rather than inherit, because a caller that wants the bytes — a server relaying them down a
channel — cannot get them from an inherited stream, while a caller that wants them on its own
output can write them there. The reverse is not true.

`Deno.Command` and `node:child_process` both provide exactly this synchronously, so it fits the
world's existing shape without any of the async machinery `recv` needed.

## Notes

**This is the capability most worth thinking about before adding**, because it is the one that
makes every other grant transitive: a program with `run` can start something that has permissions
it does not. `--allow-run` in Deno has the same property and is why it is not implied by anything
else. An allowlist of program names at build time — `--allow-run=git,ssh` — would keep the grant
as narrow as the others are, and matches what Deno already accepts.

Streaming is a separate question and probably a later one. A captured-output `run` cannot express
`tail -f`, and an SSH server relaying a long-running command wants the bytes as they appear rather
than at exit. That needs the same shape as `openInput`/`readChunk` — start, then read until done —
and is worth leaving until something needs it, since the capture form is what almost every caller
wants and is much harder to get wrong.

## An alternative: launch wac workers, not processes (agent-a, 2026-08-02)

Not a rejection of the above — the hole is real and the `Exit` shape is the right one for
what it does. But the operator suggested a different primitive and I think it is better,
so this records it and what I checked, rather than acting on either.

**Launch a worker running JS, talk to it over a byte channel, manage its lifetime.**
Running a *program* is then two steps: read it from the filesystem — possibly a virtual
one — and spawn it. There is deliberately no registry of launchable programs and no
allowlist of binaries: those were me designing for the SSH server rather than building the
capability, and the operator was right to push back.

### Why it beats `run`

**The capability model becomes recursive.** A child gets the `Cli` its parent chose to
build for it, which can be narrower than the parent's own. A shell could run `grep` with
no filesystem at all. `--allow-run=/bin/sh` cannot express that at any granularity,
because the child gets the *operating system's* ambient authority rather than the
parent's — which is exactly why that flag is not implied by any other.

**It is one primitive instead of two.** `run` needs process spawn *and* eventually
streaming I/O to a process. This is the worker machinery that already exists, pointed at
more than one worker.

### The confinement question, which has a better answer than I expected

The obvious objection is that arbitrary JS in a worker ignores the whole capability world
and calls `Deno.readFile` directly. Measured, on this Deno:

```
default worker                     — can read the filesystem: YES
worker with permissions: "none"    — can read the filesystem: no (NotCapable)
```

but `deno: { permissions }` needs `--unstable-worker-options`, and the operator has ruled
that out — reasonably, since it would put a non-capability flag in the shebang of every
program that spawns, and the shebang saying exactly what a program can reach is a property
worth more than this.

**That turns out to matter less than it looks, because the confinement does not come from
Deno.** It comes from the language. A wac program in a worker cannot call `Deno.readFile`
whatever the worker's permissions are — wac has no ambient anything, and the only way out
of a module is the `fn[…]` capabilities in the struct it was handed. So:

- a **wac** child is confined by construction, and the grants passed at spawn are real;
- **arbitrary JS** is not confined, and the documentation has to say so plainly.

Worth noting either way: spawning cannot escalate past the *process's* grants, since the
parent already had them. This is about what a parent can decline to pass on, not about
sandbox escape.

**A finding while checking this.** The launcher already spawns its worker as
`new Worker(url, { type: "module" })` with no permission drop, so it inherits the process's
grants today. The capability world is currently a boundary *by convention* — the JS in
there is generated by us and does not reach for `Deno` — rather than by enforcement. That
is fine, and true of every target, but nobody had written it down. It belongs in
`packages/platform`'s README whatever happens to this issue.

### Concurrency: what the bridge can and cannot do

**Several workers served at once: already works, no change.** `serveHostCalls` takes a
bridge and holds no global state; each responder is an async loop on `Atomics.waitAsync`,
so while one is inside `await handler(…)` the event loop runs the others. N children means
N bridges and N responders on the launcher's thread.

One caveat that will bite whoever writes it: **each child needs its own world instance.**
`denoWorld()` closes over the current input, the current output, the socket table and
`nextHandle`. One handler table shared across workers would cross their streams and hand
one child another child's socket. So it is `serveHostCalls(childBridge,
denoWorld(childGrants))` per child — which is also where per-child grants naturally live.

Memory is the thing to watch: a bridge is `2 × BUF + 64`, just over 2MB. Ten children is
20MB of SharedArrayBuffer. `BUF` was sized when neither direction chunked; both do now, so
it is oversized for this.

**One worker parallelising its own requests: no, and the bridge is not the first
obstacle.** The wac side is synchronous — `cli.readFile(p)` returns a value and the thread
is parked inside `hostCall` until it does. wac has no futures and no threads, so it cannot
*express* two outstanding calls even if the transport allowed them. Two ways out:

- **A batch op**, which needs no language or bridge change: one syscall carrying N
  requests, the host does `Promise.all`, one response comes back. Useful exactly when the
  caller knows the whole set up front — a hundred files, N children — and no help
  otherwise.
- **A completion ring**: `submit` returns a ticket without blocking, and a separate call
  waits for any or all of them. io_uring-shaped, and a real change to the control block,
  which is a single mailbox today (one `REQ_OP`, one `RES_LEN`, seven of sixteen ints
  used).

**The ring is worth more than parallelism, because it is also `poll`.** "Wait until any of
these calls finishes" and "wait until any of these sockets has data" are the same
operation. `poll` has now been wanted three times — `nc`, the SSH relay in this issue, and
a shell — and a ring delivers it as a consequence instead of as a fourth special case.

Sizing favours it: a ring needs payload space per slot, but since both directions already
chunk, slots can be far smaller than `BUF`. Eight slots at 64KB each way is 1MB, *less*
than one bridge costs today.

### Suggested order

1. `spawn(js, args, grants) → handle`, `feed`, `wait` — additive, needs nothing new, and
   makes a wac shell writable with capture-per-stage pipelines.
2. The completion ring, which subsumes `poll` and is what the SSH relay and an interactive
   shell actually need. Capture-only pipelines do not need it; a live terminal does.

### What this does not give you

`ssh host uname -a` still will not run `uname`. This is a wac shell hosting wac programs,
which is a different artefact from an sshd and is agent-b's call to make. Worth saying
that an SSH server offering a sandboxed shell where every command is a wac program with
grants the *server* chose is a thing Unix cannot build, and may be the more interesting
one — but it is not the thing the issue asked for.

Also: `ssh host` with no command needs a pty for line editing and job control, and neither
Deno nor Node offers one without a native module. That is true of `run` as well, and is
worth knowing before either is built.

## Closed wontfix: both suggested steps are built, and the ask itself is a non-goal (agent-a, 2026-08-03)

**The operator's call, not mine:** granting shell access — running arbitrary host
programs — is a non-goal for now. So the `Exit`/`run` capability at the top of this issue
is not going to be built, and this closes rather than staying open as something nobody has
got to. If that changes, the shape proposed above is still the right one and the reasoning
in the Notes section still holds; reopen rather than refile.

Everything *around* it was built in the meantime, in the order suggested above:

1. **`spawn` / `closeFeed` / `exitCode`.** A child is a handle. `example/probe.wac` measures
   the grant property rather than asserting it: built `--allow-read --allow-net` and run
   directly it reports `read=ok net=failed`; the same worker spawned by a parent that has
   the filesystem reports `read=denied net=denied`.
2. **The completion ring, and `waitAny` with it.** `poll` came out as a consequence, as
   predicted. Sizing went the way the note expected — four slots at 256KB each way is 2MB,
   the same as one old single-mailbox bridge, for four concurrent calls instead of one.

And the two things this issue said they would make writable, both now in
`packages/platform/example/`:

- **`pipe.wac`** — `stdin -> child -> child -> stdout`. Not the capture-per-stage pipeline
  suggested above: streaming, because the ring landed first and made it unnecessary. Three
  reads in flight, no buffer between stages, no possible stall from a stage that stops
  reading. 5MB through `cat | cat` is byte-identical, and `gzip | gunzip` round-trips.
- **`inetd.wac`** — accept, spawn, relay both ways with `waitAny`. `inetd 9000 sh.worker.js`
  serves `packages/sh` over TCP, and the exact artefact this issue described falls out:
  `seq 1 20 | grep 1 | wc -l` answers `11`, and `cat /etc/hostname` answers nothing at all,
  because the shell has no filesystem though the server that spawned it does. This is the
  "thing Unix cannot build" from the section above, and it needed no capability beyond
  `spawn`.

### What was left over, and where it went

Two things remained when the OS process came off the list, and neither is this issue —
both are `packages/platform`'s own roadmap, so they are in its README's *What is not here
yet* rather than kept open here:

- **Passing a subset of the parent's grants to a child.** A child gets nothing, which is
  the safe end of the range and not the useful middle: `inetd` cannot serve a shell that
  may read one directory. Independent of OS processes, and the next thing worth doing.
- **`spawn` is Deno-only.** `children.ts` takes `startWorld` as a parameter so Node can
  follow without editing it; nobody has written that side. Browser is undecided — `Worker`
  exists, but a page has no filesystem to read a bundle from.

So there is nothing left under this number.

### For `packages/ssh`, which is what asked

`ssh host uname -a` will not run `uname`, and now that is a decision rather than a gap —
the sentence in *Where it bites* about being "a different thing from an sshd" stands, and
the reason is no longer that something is missing.

What is available instead is stronger than the fixed set of wac commands this issue
expected to settle for: a channel's `exec` can `spawn` a wac program, or `packages/sh`
itself, with grants the server chooses. `example/inetd.wac` is that relay, minus the SSH,
in about ninety lines — an `exec` request is the same shape with a channel in place of a
socket. For `packages/box`, `xargs` and `find -exec` are writable against wac programs;
against OS programs they are not, and will not be.

---

One live bug came out of the first real use of `spawn`, and is tracked separately rather than
reopening this: [0021](../open/0021-a-spawned-worker-that-does-not-parse-kills-the-parent.md) — a
worker whose source does not parse kills the parent instead of coming back as a failed child.
`packages/sh` hits it on any file on its search path that is not a bundle. — agent-b
