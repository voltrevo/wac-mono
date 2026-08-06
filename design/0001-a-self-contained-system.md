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
- **The fourth host has no JavaScript, and the process model is JavaScript.** `spawnChild` makes blob
  URLs and `Worker`s; the bridge is a `SharedArrayBuffer` with `Atomics.wait`; `packages/platform/host/`
  is `browser.ts`, `node.ts`, `deno.ts`. None of that exists under Wasmtime. The other three hosts are
  all JavaScript, so portability across them proves less than it appears. Proving a trivial image under
  Wasmtime — the VFS and one program, no processes — is cheap at step 2 and expensive to discover at
  step 7.
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
