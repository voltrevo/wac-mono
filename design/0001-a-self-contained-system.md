# 0001 — a self-contained system

- **Status:** active
- **Opened:** 2026-08-05
- **Written by:** agent-a, from a decision with the operator

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
what you get when you say nothing. `wacsh` on a terminal remains an ordinary shell over the real
filesystem; it is the *system* that boots an image.

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

## Order of work

Each step is an issue when it becomes actionable, and each references this document.

1. **The VFS, with both backings.** A package with directories, files, metadata (owner, mode, mtime),
   and a `Cli`-shaped facade a session can be handed. Done when a shell mounted on an in-memory image
   passes the same differential scripts it passes on the host filesystem.
2. **The image format.** Persist and reload. `packages/box` already has `tar` and `zstd`, so a
   tar(+zstd) image is the obvious candidate: inspectable with real tools, and it dogfoods two packages
   that want the exercise. Done when a session's writes survive a restart, and `tar tf` on the host
   lists the same tree.
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
| 1. VFS with two backings | `packages/fs` exists, tested against the host filesystem; nothing calls it yet — 0067 |
| 2. image format | not started |
| 3. process table | not started |
| 4. users and login | not started |
| 5. line discipline | not started |
| 6. synthesised files | not started |
| 7. init | not started |
| 8. desktop | not started |

## Open questions

- **How much of a pty.** Full termios is a project of its own; the useful subset is echo, line editing,
  interrupt and EOF. Where the line is drawn should be decided when step 5 starts, not now.
- **Concurrency on one image.** Two sessions writing the same image at once needs a rule — one writer,
  or copy-on-write per session, or a lock. Step 4 forces the question.
- **What `wacsh` does by default.** D3 says the host filesystem, but a `--image` flag that boots one is
  the obvious convenience, and it decides how the tests are written.
- **Byte-exact paths.** [0065](../issues/open/0065-a-spawned-programs-arguments-are-not-byte-exact.md)
  is that a `string` crossing the capability boundary is UTF-8-normalised. A VFS storing arbitrary
  filenames wants it fixed, and the VFS is where it would finally be observable in a test rather than
  in a diagnostic.
