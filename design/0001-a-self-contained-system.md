# 0001 — Wacland: a self-contained system

- **Status:** active
- **Opened:** 2026-08-05
- **Written by:** agent-a, from a decision with the operator
- **Extended:** 2026-08-06 by agent-c, folding in the frame from
  [voltrevo/wac-mono#38](https://github.com/voltrevo/wac-mono/issues/38)

## The name, and the external issue

The system is called **Wacland**. GitHub #38 states the same direction as this document in a wider
frame, and it was written four days later; the two are one plan and this is the authoritative copy.
GitHub is an independent external guide, read inward and not written back to — so what #38 adds is
folded in below rather than linked to, and where the two disagree this wins.

What #38 supplied and this did not: the name, the four hosts stated as a portability requirement, the
layering rule (D8), the boundaries, and the arrival test. What this has and #38 does not is the part
that makes it a plan — the decisions with their reasons, the eight steps, and the state of play.

## What we are aiming at

`packages/ssh`'s demo should present a machine. Log in over real OpenSSH, land in a shell, and find a
filesystem with `/etc/passwd`, a home directory, `/bin` full of programs, a process table you can
`ps` and `kill`, and a `^C` that interrupts — none of which touches the host it happens to be running
on. The browser terminal should be the *same system* in a tab rather than a second port of the idea,
and eventually a desktop over it.

What it is **not**: a Linux emulator. No ELF loading, no syscall emulation, no qemu. The userland is
`packages/box`'s applets and `packages/sh`, which are wac programs compared against GNU's behaviour;
the system underneath them is wac too. "Convincing" means the parts that exist are real, not that
everything a Linux has is present.

### The same system wherever it runs

One image, and the same users, files, programs, shell behaviour and services in each of:

- a browser;
- Deno, Node or Bun;
- the userland of a bootable system — a minimal Linux kernel and Wasmtime, no JavaScript at all.

The host supplies execution and the capabilities it is explicitly granted. Wacland supplies everything
the user experiences as the system. An image moves between hosts carrying its state; it does **not**
carry live processes or connections.

**The arrival test** (#38's "first convincing proof", and better than anything this document had): load
the same image in two substantially different hosts and demonstrate the same users, files, installed
programs, shell behaviour and system services in both, with no implicit access to either host.

Read "substantially different" as **one JavaScript host and one that is not** — D9. Two JavaScript
hosts satisfy the words and prove nothing, since they share the transport, the worker model and the
event loop.

### What it is not

Not a Linux emulator, and the boundary is worth stating in full because "self-contained system" invites
the assumption: no Linux syscall ABI, no ELF or arbitrary native binaries, no obligation to reproduce
Linux internals, and no dependence on a particular JavaScript or WebAssembly runtime. A graphical
desktop is step 8 rather than part of the definition, though the mechanisms under it should support one.

## Why this is a small architectural step

Nothing here needs a new host feature. It needs work, but the shape is already load-bearing:

- **A capability world is a struct of funcrefs.** `packages/sh/test/wac/probe.wac` already builds a
  whole `Cli` out of wac functions to fake a filesystem for the coverage probe. A kernel, in this
  design, is a wac program that *synthesises worlds for its children* — the same trick, kept.
- **Two process models exist.** `spawn`/`spawnSelf` give a real one (a worker, its own instance, its
  own grants); `pushChild`/`popChild` give an in-process one, which is what runs sixty applets in a
  browser tab. What is missing is that nobody keeps a table.
- **A userland exists.** Sixty applets, a shell tested against bash script for script, `ssh`/`sshd`,
  `httpd`, `tar`, `gzip`, `zstd`, `json`.
- **Grants already narrow by construction**, which is a better answer than mode bits to "what may this
  session do". A session's world is built with what it is allowed and nothing else.

## Decisions

**D1 — the filesystem lives in wac.** A VFS in a wac package, not a host implementation. That is what
makes one system serve Deno, Node and the browser identically, and it is the only way a session can be
sealed off from the host filesystem while still being a *filesystem*.

> Landed as `packages/fs`, and the language narrowed the shape: no closures and static dispatch mean a
> filesystem cannot be a facade of funcrefs or an abstract base with two implementations. It is one
> concrete type with a **mount table**, which was going to be step-something-later and is in fact the
> natural shape from the start — a host mount is how D3 is expressed.

**D2 — two backings, both first-class: memory and a persisted image.** In-memory is the default for
tests — hermetic, fast, and no `/tmp` — and persistence is what makes the demo a machine rather than a
transcript. Neither is the "real" one: the same VFS with a different store.

**D3 — host access is an explicit mount, not the default.** Today a shell's capabilities are the host's
filesystem, and that stays available *by asking* — a mount, named in one place — rather than by being
what you get when you say nothing.

**D3a — two binaries** (operator, 2026-08-05). `wacsh` stays an ordinary shell over the real filesystem,
and a separate entry point boots an image and serves a system from it. Clearer than a flag for the demo —
what each one is for is in its name — at the cost of two entries to keep in step, which is what the
differential corpus is for: both run the same scripts.

**D4 — the kernel is a wac program that synthesises capability worlds.** A session gets a `Cli` whose
`readFile`, `writeFile`, `readDir`, `stat`, `remove` and `rename` are the VFS's, whose `arg`/`env` are
the session's, and whose `spawn` goes through the process table. No ambient anything, which is the
property the capability world already has and which this must not spend.

**D5 — users and permissions are data in the image.** `/etc/passwd` is a file the system reads, not a
host concept, and ownership is stored beside the inode. Host permissions are not consulted and cannot
be, since the image may be a single blob owned by whoever ran the process.

**D6 — nothing is faked to look complete.** A process table is a table or it is absent; `ps` printing
plausible rows would be the "wrong answer, quietly" shape this repo keeps removing. Where something is
not implemented, it says so in those words.

**D7 — differential testing stays the oracle.** The applets keep being compared against GNU coreutils
and the shell against bash. The VFS is an opportunity here rather than a threat: the same scripts can run
against a host mount *and* against an image, and any divergence between those two is a VFS bug with a
reference answer.

**D8 — POSIX is a personality over a native core, and the dependency runs one way** (#38). Wacland
should not treat POSIX or Unix abstractions as fundamental merely because they are familiar. The native
foundations are the ones this repo already reaches for — explicit capabilities, structured process
lifetimes, typed communication, supervised services, portable system objects — and POSIX and GNU
behaviour are a *compatibility personality* built over them.

> The POSIX personality may depend on the Wacland core, but the Wacland core must not depend on the
> POSIX personality.

The reason to write it down now, before there is a core to violate it: `packages/sh` and `packages/box`
are the userland and they are POSIX-shaped, so the natural drift is for the core to grow whatever they
happen to need. These abstractions are deliberately unstable while Wacland and wac are young.

**D9 — Wasmtime directly is the portability proof; bootable is packaging on top** (operator,
2026-08-06). The three hosts today are a browser, Deno and Node, and all three are JavaScript. Bun
would be a fourth JavaScript host and prove nothing new. **Wasmtime is the first host that is not**, so
it is the only one that tests D8's claim at all.

Running under `wasmtime` as an ordinary program comes *before* a bootable image, because bootable is
Wasmtime **and** no operating system **and** a kernel **and** `init` **and** a block device, and only
the first of those says anything about whether Wacland is portable. One variable at a time.

What that separates, and the distinction is the useful part:

- **the transport is JavaScript's** — the `SharedArrayBuffer`, `Atomics.wait`, the sequence counters,
  the responder. It exists to park a worker while an asynchronous host runs, and under a synchronous
  host it should not exist at all.
- **the interface is not** — a request returns a *ticket*, and `waitAny` takes a set of them and a
  deadline. That is the right shape whatever the host: asking for something external must not imply
  serialising on it, which is why the bridge went from one mailbox to a ring of slots in the first
  place. Two files at once, a relay between two sockets, several children.

So the second binding implements `Pending<T>` **properly**. A host that resolved every ticket
immediately would satisfy the types and quietly make every program that overlaps requests sequential —
D6's shape exactly, and worse than not having the host, because it would pass.

**D10 — the host is a native runtime, written in Rust on wasmtime** (operator, 2026-08-06). Not
`wasmtime run`, which cannot host this: a wasm module cannot instantiate another wasm module, so
`spawn` is impossible without an embedding, and the thirty-six capability funcrefs have to come from
somewhere. **Spawn is not optional** — it is what makes a pipeline concurrent (`pushChild` runs stages
one at a time, which is why `yes | head -1` does not terminate as bash's does) and it is step 3's
whole subject.

So this is a runtime binary whose job is to run wac programs: the peer of `deno.ts`, `node.ts` and
`browser.ts`, in the role Deno plays but Wasm-native and with no JavaScript in it. Rust rather than the
C API that `cc` could build today, because the runtime's job is *confinement* and the parts it needs —
a ticket table, a thread per child, message queues between them — are exactly what C makes
error-prone.

It is also the **simpler** host, which is the strongest evidence for D9's split. The
`SharedArrayBuffer`, `Atomics.wait`, the sequence counters, the ring of slots and the responder all
exist to park a worker while an asynchronous host runs. Native code blocks the calling wasm thread
directly and completes tickets from its own threads, so the whole transport collapses to a ticket
table and a condvar. The artifact simplifies too: no launcher, no bundle, no base64 — a `.wasm` and a
manifest of grants.

**D11 — no WASI, in either direction** (operator, 2026-08-06). A wac module built today imports
**forty-three functions, all of them `wac.cbN` callback dispatchers, and nothing else.** No ambient
namespace exists, and none is added:

- **the guest imports no WASI.** WASI is a namespace of syscalls a module declares and then has,
  narrowed afterwards by preopens and configuration. A capability struct is the inverse — exactly what
  was granted, and reading it tells you what the program can reach. With both present the second stops
  being true: `sealed.wac` is a session built with no filesystem grants at all, and a preopen is a
  mount nobody named, which is D3 undone. `Pending<T>` would not survive it either, since WASI preview
  1 blocks by default and half of a program's I/O would stop composing with `waitAny`.
- **the runtime does not use WASI internally.** It is native code; it has `std::fs`, `std::net` and
  threads. WASI is a way for *wasm* to reach the operating system and the runtime is not wasm.

That second point retires a constraint recorded here earlier: `poll_oneoff` subscribes only to
descriptor readiness and clocks, so a ticket for `render`, `nextEvent` or a child's exit would have had
no subscription. That was premised on WASI being the readiness mechanism. In a native host `waitAny` is
a condvar over a ticket table and readiness is whatever completes it — a socket, a timer, a child
exiting, an event queued by the embedder — uniformly.

**Where WASI would earn a place is later, and above rather than below.** If Wacland is ever to run wasm
it did not compile, those modules speak WASI, and the runtime should then implement WASI *over* the
capability world: `path_open` resolved through the VFS, preopens being mounts, `fd_read` becoming a
ticket. That is D8 one level down — WASI is to the runtime what POSIX is to the userland, a
compatibility personality over native foundations and never the foundation. Written down now so that
whoever wants it builds it that way round.

**D12 — a fully deterministic execution mode is a goal of the native runtime, and only partly reachable
before it** (operator, 2026-08-06). Everything hard about testing this system comes from interleaving: a
zero-length write ended a stream *only when a reader happened to be parked* (0078); a corpus hangs about
once in fifty runs *and only on an idle machine* (0082). The response so far has been to make the
semantics enumerable — the queue, the child lifecycle and the bridge protocol are pure transition
functions with every interleaving walked in `packages/platform/test/*_model.test.ts` — and that catches
design bugs, but it cannot reproduce a *run*.

Reproducing a run needs the schedule to be ours. **In the JavaScript hosts it can only be partly ours**,
and the boundary is worth stating precisely rather than discovering:

- **what we can own today.** A worker makes progress only when the host answers it, so a test-mode
  scheduler can let exactly one worker run at a time and choose the order answers are delivered in. When a
  program parks on `waitAny` with several tickets ready, which one it sees is *our* choice — the protocol
  permits either, and today it is decided by timing.
- **what we cannot.** Whether a real `readFile`, `accept` or child exit has completed is the kernel's
  business. So the *choice set* — which workers are unblockable right now — is not reproducible from a
  seed, even though the choice among them is. A worker parked on two OS-backed tickets, one of which will
  never complete until something else is unblocked, cannot be distinguished from one that is merely slow.
- **so the honest claim is "deterministic over a world the scheduler owns"**: an in-memory filesystem, a
  scripted network. `packages/fs`'s memory backing and `sealed.wac` already provide the first of those.
  Anything touching the real filesystem or a real socket gets improved reproducibility, not a guarantee,
  and the mode should say so rather than implying more.

**In Wacland the boundary moves.** The runtime owns the ticket table, the threads, the clock and the
syscalls, so nothing can complete except by its own doing: the choice set becomes ours, "nobody can
proceed" becomes a *proven* deadlock rather than an inference from frozen counters, and a seed really is
the whole schedule. That is a reason to build the ticket table and `waitAny` with a scheduler seam in them
from the start, rather than adding one later — the runtime should be able to answer "who is runnable?"
without asking the operating system.

**Until then, record rather than only generate.** A seed cannot carry what the kernel decided, but a log
of the choices actually made can: a run that wedges leaves its schedule behind, and replaying the log
reproduces it where replaying the seed might not. That is what would settle 0082, which has been observed
half a dozen times and never once with its interleaving in hand.

**D13 — virtual time: the clock is a scheduling decision, not a measurement** (agent-b, 2026-08-06,
prompted by the operator). D12 makes a run *reproducible*. It does not make a run *fast*, and those are
separate properties: a runtime can own the clock completely and still make every test wait eighteen
hours. Owning the clock buys replay; **advancing** it buys coverage, and nothing in D12 implies the
second.

The rule that makes it work is the one Shadow uses — tor's own discrete-event simulator, which exists
for exactly the problem below:

> Simulated time advances only when nothing is runnable. When every worker is blocked, the scheduler
> jumps the clock to the earliest deadline among them and settles precisely those waits.

That is not "mock `now()`". A mocked clock lets a test *state* a time; a scheduler-owned clock lets a
test *pass through* one. The difference is the whole feature.

**What it is worth, concretely.** Everything the tor stack has pinned is a steady state: given this
consensus, choose these directories; given these bytes, accept or refuse. Every **transition** is
untested, because each needs hours of wall clock:

- a descriptor published, the time period rolls, the service republishes — can a client still find it?
  `serviceStorePeriods` exists for precisely that boundary and has only ever been tested at two frozen
  instants.
- an introduction point expiring (18–24h, drawn) while an INTRODUCE2 is in flight.
- a consensus expiring mid-circuit; `refreshAt` picks a re-download time in a window and nothing has
  ever watched it fire.
- a revision counter's monotonicity across a service restart.

And one that is already costing accuracy rather than only coverage: `test/data/hsdir_vectors.json` has
`periodLength: 8` **minutes**, because chutney shrinks the voting interval to twenty seconds to make
rotation observable at all. Production is 1440. So `timePeriodLength(testingNetwork: true, …)` is the
branch under test and the production branch has never met a live network. Virtual time removes the
reason to shrink the interval, which is a correctness win and not a speed one.

**The obstacle is already in the interface, and it is small today.** `core.waitAny(ids, millis)` puts
the deadline inside `Atomics.wait`, in the worker's own memory. The scheduler can enumerate every
ticket and still cannot see *"this worker gives up in five seconds"* — so it cannot answer "who is
runnable?" honestly (a worker with a live deadline is runnable at a future time), and it cannot know
which time to advance to. `platform.wac` records that a timer **ticket** was the original design and was
replaced because "`Atomics.wait` already takes a timeout, so the deadline needs no ticket, no slot and
no cleanup at all". Both reasons are JavaScript's. `core.sleepMillis` is still a ticket, which is the
shape virtual time wants — so the inconsistency is confined to the deadline path, and D12's own argument
applies: this is where the seam goes, and retrofitting it later means touching every wait.

**Two modes, and they are not substitutes.** Naming them now matters more than building either, because
the temptation is to build the first and believe it covers the second:

- **closed world** — an in-memory filesystem, a scripted network, virtual time. Genuinely deterministic;
  a seed is the whole run. Answers *what happens when things interleave and time passes*.
- **open world** — a real C tor on the other end of a real socket. Our side reproducible, the peer's
  not. Answers *are we right*.

**The tension is fundamental: virtual time XOR a real peer.** A tor process has a real clock, so
anything it participates in runs at wall speed. Shadow escapes this only by simulating every node,
which for us would mean intercepting a real tor binary's syscalls — a larger project than the runtime
itself and probably never worth it.

**And the trap, which is worth stating in the same breath as the goal.** A closed world is the ultimate
symmetric oracle: our stack agreeing with itself, forever, at high speed. Determinism makes a wrong
answer *reliably* wrong. Every real defect found in the tor work this week came from C tor and none
would have been caught by a simulator — `HS_DESC_MAX_LEN` compared with `>=` rather than `>`, the
strictly-greater revision-counter rule, `crypto_rand_int_range` being half-open where its own comment
says inclusive, and every HSDir in a real consensus having `DirPort 0`. A deterministic mode should be
sold as a coverage and debugging multiplier, which is large, and not as an oracle, which it is not.

**Two hazards it introduces**, both known from Shadow and neither obvious:

- **a program that polls instead of blocking hangs the simulation.** It stays runnable, so the clock
  never advances, so its poll never becomes true. `waitAny(ids, 0)` — "which is ready right now" — is
  exactly that shape, and a loop around it would spin forever in virtual time while working fine in
  real time. The runtime should be able to say so: *no progress, and no blocking wait* is a diagnosable
  state, not a hang.
- **timeout constants become load-bearing.** Today `waitAny(…, 5000)` is a safety net that rarely
  fires. Under virtual time it fires at exactly five simulated seconds, so which side of it a test lands
  on becomes deterministic — which is the point, and also means changing a timeout changes outcomes.

**The path, smallest first.** Each step is useful alone, which is the test of whether the staging is
honest:

1. **Make the deadline visible** — no semantic change. A worker records its deadline in shared memory
   before parking; `Atomics.wait` still implements it. Costs one store, and gives the scheduler
   "earliest deadline among blocked workers" for nothing. Everything else needs this and it is a few
   lines.
2. **A clock policy in the test scheduler.** `WAC_SCHED` already selects delivery order; add the clock
   beside it. Under a virtual clock, `nowMillis` and `monotonicNanos` read the scheduler's counter, and
   when nothing is runnable the scheduler advances to the earliest recorded deadline and settles exactly
   those waits.
3. **Ship it with the closed world.** D12's honest claim is "deterministic over a world the scheduler
   owns"; virtual time is only *useful* over the same world. `packages/fs`'s memory backing is half of
   it and a scripted network is the other half.
4. **Wacland re-decides timer-as-ticket** rather than inheriting the JavaScript answer. The runtime owns
   the ticket table and the threads, so a deadline can be a ticket without costing a ring slot or a
   cancellation path.
5. **First target is not a tor network.** `relayd` + `dird` + a client is the smallest system here with
   a real race — a circuit extend against an accept — and it is where run-to-run nondeterminism already
   bites. The demonstration that would settle the argument: publish a descriptor, cross a time-period
   boundary in simulated time, and fetch it as a client. Two hundred milliseconds, and today untestable
   at any speed.


## Order of work

Each step is an issue when it becomes actionable, and each references this document.

1. **The VFS, with both backings.** A package with directories, files, metadata (owner, mode, mtime),
   and a `Cli`-shaped facade a session can be handed. Done when a shell mounted on an in-memory image
   passes the same differential scripts it passes on the host filesystem.
2. **The image format.** Persist and reload. **A format of our own** (operator, 2026-08-05) rather than
   tar: cheaper incremental saves and exact metadata, at the price of nothing outside this repo being able
   to read it. Two things follow from that price, and both are part of the step rather than extras — a
   `dump` that prints an image's tree so a person can inspect one, and a round-trip property test, since
   there is no GNU tool to be the oracle. Done when a session's writes survive a restart and an image
   written by one build loads in the next.
2a. **A second host, with no JavaScript in it.** The native runtime, per D9, D10 and D11. Done when,
   with no JavaScript in the artifact and no WASI import in the module:
   - a program issues **two** capability requests that complete out of order, `waitAny`s over both, and
     observes them settle independently;
   - a `waitAny` with neither ready returns on its **timeout**;
   - and it **spawns a child** and `waitAny`s over one of its own tickets *and* the child's exit at the
     same time.

   That last clause is the one that exercises all three of D10's requirements at once, and the reason
   spawn is in the criteria rather than deferred to step 3: a runtime that cannot make a second
   instance is not a host for this system, and finding that out at step 3 would be finding it out
   after the design had been built on it. Deliberately *not* "runs a program against the VFS", which
   would pass without touching any of it. No shell and no services yet — those come later, and the
   process **table** is still step 3; this is the primitive underneath it.

3. **A process table.** Pids, parents, states, exit statuses; `ps`, `kill`, `jobs`. The processes are
   already there — spawned workers, or `pushChild` frames in a browser. Done when `ps` in the ssh demo
   shows the pipeline you are running and `kill` ends one.
4. **Users and login.** sshd authenticates a key already: map it to a user, set `HOME`/`USER`, and
   enforce ownership in the VFS. Done when two keys land in two homes and neither can read the other's
   private file.
5. **A line discipline.** Echo, backspace, `^C` → interrupt, `^D` → end of input, `^U`, and a `TERM`
   worth setting. One module for both the ssh channel and the browser's keydown loop. Done when `^C`
   ends a running `yes` in both, and interactive `read` behaves as bash's does.
6. **Synthesised files.** `/proc/self`, `/proc/<pid>`, `/dev/null`, `/dev/urandom`, `/dev/zero`. Cheap
   once the VFS exists and disproportionately convincing. Done when `cat /proc/self/cmdline` answers and
   `head -c 16 /dev/urandom | hex` works.
7. **`init`, and a system that boots.** Something owns the image, starts the daemons, and reaps. Done
   when the ssh demo is one program that boots an image and serves sessions from it.
8. **The desktop, in the browser.** `Page` has render, events and pixels; a window manager in wac over
   the same system, with the terminal as one window. Deliberately last: windows want something to show.

## State of play

| step | state |
|---|---|
| 1. VFS with two backings | **done.** `packages/fs`, threaded through `packages/sh` as a value the shell holds; `sealed.wac` is a session on `Fs.inMemory()` built with no filesystem grants at all. 57 scripts answer identically on both backings and identically to bash — 0067 |
| 2. image format | not started |
| 2a. a second host, no JavaScript | not started — [0087](../issues/open/0087-wacland-under-wasmtime-a-second-host-with-no-javascript.md) |
| 3. process table | not started |
| 4. users and login | not started |
| 5. line discipline | not started |
| 6. synthesised files | not started |
| 7. init | not started |
| 8. desktop | not started |

## Open questions

- **The native core has no oracle.** D7 makes differential testing the oracle, and the oracles are bash
  and GNU coreutils — which judge the *personality* only. Under D8 the native core is the first large
  subsystem here with nothing independent to check it against, in a repo whose rigour is mostly
  differential. What plays that role — a reference implementation of the same semantics, property tests
  over the capability algebra, something else — should be decided with the core rather than after it.
  This is the largest open risk in the direction.
- ~~The fourth host has no JavaScript.~~ Answered by D9, D10 and D11, and scheduled as step 2a.
  ~~Whether plain WASI can express the interface.~~ Answered: it cannot, and it is not used — D10 and
  D11. What remains is not a design question:
- **Where the native runtime lives.** The other three hosts are `packages/platform/host/*.ts` and the
  interface they implement is defined beside them, which argues for keeping the fourth there. Against:
  cargo is a second build system, `deno task test` cannot cover it, and "no TypeScript in any package's
  `src/`" is a stated property of this repo that "…and some Rust" muddies. Its own bare repo, or
  `packages/platform/host/native/`. An operator decision, and not urgent until 0087 starts.
- **The toolchain is a precondition, not a detail.** No `cargo` or `rustc` here, and this repo has no
  compiled language at all today — 371 `.wac`, 305 `.ts`, with Python and shell only as tooling. Needs
  `sudo` plus proxy allowlist entries for rustup and crates.io. Only whoever *builds* the runtime needs
  it; everyone else gets a binary.
- **Supervised services are named in D8 and in none of the eight steps.** Step 7 is `init`, which owns
  the image, starts daemons and reaps; supervision — restart policy, dependency order, health — is a
  different shape. Either it belongs in step 7's definition of done or it is a ninth step.
- **How much of a pty.** Full termios is a project of its own; the useful subset is echo, line editing,
  interrupt and EOF. Where the line is drawn should be decided when step 5 starts, not now.
- **Concurrency on one image.** Two sessions writing the same image at once needs a rule — one writer,
  or copy-on-write per session, or a lock. Step 4 forces the question.
- ~~What `wacsh` does by default.~~ Answered: two binaries, D3a.
- ~~Byte-exact paths.~~ Answered:
  [0065](../issues/closed/0065-a-spawned-programs-arguments-are-not-byte-exact.md) is a *signature* problem
  — names and arguments are bytes, messages and source are text — and not something to solve with a codec
  in the compiler. `packages/fs` already pins the property on a mount, where no host API is involved.
