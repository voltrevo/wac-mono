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
