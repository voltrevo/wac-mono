# 0067 — no filesystem of our own, so a session cannot be sealed off from the host

- **Status:** open
- **Claimed by:** agent-a (2026-08-05)
- **Reported by:** agent-a
- **Date:** 2026-08-05
- **Kind:** missing feature
- **Symptom:** not implemented

Step 1 of [design/0001](../../design/0001-a-self-contained-system.md), which is where the reasoning and
the decisions live. This issue is the actionable slice.

## What

Every filesystem capability a program has is the *host's*. So `packages/ssh`'s demo, which is meant to
present a machine, hands each session the real disk of whatever ran the daemon, and the browser terminal
hands it the tab's Origin Private File System. There is no filesystem that belongs to the system rather
than to the host, which means:

- a session cannot be sealed off — `cat /etc/shadow` in the ssh demo reads the *host's* file, or fails
  for the host's reasons;
- there is nothing to persist as an image, so nothing survives a restart in a shape anybody can inspect;
- the two demos are two ports of one idea rather than one system with two terminals;
- and every test that touches a filesystem needs a temp directory, which is where today's flakes come
  from (`No space left on device` from a shared disk, `Text file busy` from a parallel build).

## What it takes

A package with a virtual filesystem, and a `Cli`-shaped facade a session can be handed:

- **Directories, files, and metadata** — owner, mode, mtime, size. Ownership stored beside the inode,
  because users are data in the image (design/0001 D5).
- **Two backings, both first-class** (D2): in memory, which is the default for tests, and a persisted
  store. Neither is the real one; the same VFS with a different place to keep bytes. The image *format*
  is step 2 and not this issue — this one needs the seam where a store plugs in, not tar.
- **The facade**: `readFile`, `writeFile`, `stat`, `linkStat`, `readDir`, `mkdir`, `remove`, `rename`,
  `openInput`/`readChunk`, `openOutput` — the same signatures `platform.wac` declares, so a session's
  `Cli` can be built from them with no shell or applet changed. `sh/test/wac/probe.wac` already
  synthesises a `Cli` this way for the coverage probe, which is the proof the shape works.
- **Faults, not sentinels**: the same `Change`/`FileResult` categories the hosts answer with, so
  `rm -f`, `mkdir -p` and the diagnostics that were matched against GNU keep behaving.

## Done when

A shell mounted on an in-memory VFS passes the same differential scripts it passes on the host
filesystem — the corpus in `packages/sh/test/differential.test.ts` has a filesystem tier, and running it
twice, once per backing, is the test. Any divergence between the two is a VFS bug with a reference
answer, which is the property worth building for (design/0001 D7).

## Notes

Deliberately *not* in this slice: the image format (step 2), a process table (step 3), users and login
(step 4). A mount table is not needed yet either — one filesystem, chosen when the session is built.

Watch for two things the host does that a naive VFS will not:

- **`readDir(".")`** and relative paths generally. The shell resolves every path to an absolute one
  before it crosses the boundary, which the VFS can rely on — but `openInput("")` means standard input,
  and `""` is not a path.
- **Byte-exact names.** [0065](0065-a-spawned-programs-arguments-are-not-byte-exact.md) is that a
  `string` crossing a capability is UTF-8-normalised. Inside the VFS a name is whatever bytes it was
  created with, so the VFS is where that bug becomes observable in a test rather than in a diagnostic —
  worth a case that fails today and passes when 0065 is fixed, marked as such.

## Half done, 2026-08-05 (agent-a)

`packages/fs` exists: `Fs` with a mount table, a memory backing, a host backing, and the operations the
shell needs — `readFile`, `writeFile`, `stat`, `linkStat`, `readDir`, `mkdir` (with `-p`), `remove` (with
`-r`), `rename`. Twelve tests: six in wac for what a differential cannot reach, and six comparing
transcripts of the same operation script run in memory and against a real disk.

**The "Cli-shaped facade" in the description above was the wrong idea, and the language said so.** A
facade of funcrefs cannot reach a filesystem: wac has no closures, so a funcref cannot capture one, and
`override` is a source-level check with static dispatch, so an abstract `Fs` with two implementations
would always run the base's bodies. What works is the language's own idiom — one concrete type, state
passed explicitly, and the branch written by hand. That is a mount table, which the design deferred to
later and which turns out to be the natural shape from the start: a **host mount** is how reaching the
real disk survives as something a caller asks for.

**What is left of this issue:** nothing calls it. `packages/sh` still reaches `sh.cli` for file
operations, and threading `Fs` through the shell — nine places, per its README — is what makes a session's
filesystem a choice. The differential the "done when" asks for (the same scripts over both backings)
needs that thread, and the `ops` differential is the honest proof available before it.

**A question the differential raised, for whoever wants it:** the category set has no "is a directory", so
`cat` on a directory answers `FAULT_OTHER` and carries the reason in its message — which is what the hosts
do, so `packages/fs` matches them rather than inventing a divergence. But a program *does* branch on it:
`cat` on a directory and `cat` on a missing file are different mistakes, and `rm` already gets
`FAULT_NOT_EMPTY` for the same kind of reason. Adding `FAULT_IS_DIR` would touch `host/faults.ts`, three
hosts and `platform.wac`. Worth doing when something needs it, not before.

## Threaded, and there is a sealed shell to show it (agent-a, 2026-08-05)

The filesystem is a value the shell holds. `Shell` has an `Fs`; the sixteen places in `exec.wac` and the
twelve programs in `program.wac` go through it; `run`, `runStreaming`, `dispatchProgram`, `readOne` and
`gather` carry it. `Shell.create` builds `Fs.onHost(cli)`, so `wacsh` is exactly what it was — the corpus's
751 scripts still agree with bash, which is the assertion for a change of this shape.

**`packages/sh/src/sealed.wac`** is the payoff and the demonstration: the same shell handed
`Fs.inMemory()`. One line of difference.

```
$ sealed -c 'mkdir d; echo hi > d/f; cat d/f'     hi
$ sealed -c 'ls /'                                (nothing: an empty world)
$ sealed -c 'cat /etc/passwd'                     cat: /etc/passwd: No such file or directory
```

The part worth more than the tests: it is **built with no filesystem grants at all**. `buildApp(…, {})`
means the world has no `fs`, so the program could not reach the host if it tried — the seal is the
capability world's, and the mount table is what makes the session *usable* rather than merely harmless.
`packages/sh/test/sealed.test.ts` asserts the host directory is byte-identical afterwards, and that the
shebang asks for neither `--allow-read` nor `--allow-write`.

**What is still not sealed, and it is named in the program's own header rather than left to be found.**

- **A redirection on a pipeline's last stage** streams through `openOutput`, which is a capability rather
  than a filesystem operation. In `sealed` the collecting path handles `>` because nothing is spawned, but
  `Fs` needs an output sink before a streaming redirection can go to a memory mount.
- **A spawned applet gets its own filesystem.** `spawnSelf` starts a fresh instance, so a sealed session
  that spawned its twelve would find its own files missing — which is why `sealed` does not set
  `externalSpawnable`. Whether a child can be handed the parent's `Fs` at all is the open question, and it
  is the same question an image raises: two sessions on one filesystem need a rule (design/0001's open
  question about concurrency).

So this issue's "done when" — the same differential scripts over both backings — is now *possible* and not
yet done: the corpus drives `wacsh`, and pointing it at `sealed` needs the two holes above closed, since a
script that redirects or spawns would diverge for reasons that are not VFS bugs. That is the next slice.
