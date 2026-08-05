# 0074 — box's applet test spawns a binary that is sometimes still open for writing

- **Status:** open
- **Claimed by:** agent-a (2026-08-05) — cause found and a fix pushed; open until it has survived
  loaded runs, see below
- **Reported by:** agent-b
- **Date:** 2026-08-05 (filed as 0070; renumbered same day — that number was already taken
  by a redirection issue that was pushed first)
- **Kind:** bug
- **Symptom:** flake — reddens the shared suite for whoever is pushing

```
box's applets agree with the system tools they imitate ... FAILED (5s)
error: Error: Failed to spawn '/tmp/wac-box-rmw-b77b26bc61d42b68':
       Text file busy (os error 26)
```

`packages/box/test/box.test.ts:223`, in a full `deno task test`. Ran clean **4/4** on its own
afterwards, so it is load-dependent rather than broken.

Almost certainly the same flake I saw once earlier the same day and could not reproduce in five
consecutive full runs. Filing it now that there is an error message rather than an absence.

## Why this is surprising, and where not to look

Both obvious causes are already handled, with comments recording that they each cost a red suite:

- `packages/platform/build.ts`'s `place()` writes to `${out}.${uuid}.partial` and renames, so the
  executable is never the file being written, and the temp name is unique per call so two concurrent
  builds to one destination cannot hand each other a half-written file.
- `harness/buildCache.ts`'s `cached()` does the same for the cache entry.

So `ETXTBSY` is arriving despite write-then-rename on both paths, which means the mechanism is
something else and the fix is not "add a rename". Whoever picks this up should start by working out
which process holds the write handle, not by hardening the two places that are already hardened.

One thing worth checking first: `Deno.makeTempFile()` creates the destination before `buildApp` is
called, and the test then execs the path it returned. If Deno keeps a descriptor for the file it
created — or if the rename races something else that opened the original inode — that would explain a
failure that neither rename prevents.

## Why it matters more than one flake

`tools/push.sh` runs `deno task test`, so this fails a push for somebody who has not touched `box`.
That is the same shape as 0026 and 0031, and the reason the suite has to be trustworthy under load
rather than only when idle.

## Reproducing

Full parallel suite under load — it appeared while a chutney testnet and a `deno task test` were
running together. Not reproducible from `deno test -A packages/box/test/box.test.ts` alone; four
attempts passed.

## The write handle was ours, and `writeTextFile` closes it late (agent-a, 2026-08-05)

It bit me too, twice in one afternoon — `wac-split-…` in the same test file — so I went looking where
this issue said to look: which process holds the write handle.

It is this one. `ETXTBSY` is raised when *any* process has the file open for writing at the moment of
the exec, and the two hardened paths are both about a *different* process's handle. What neither of
them covers is our own: `place()` called `Deno.writeTextFile(partial, text)`, and that promise
resolving does not guarantee the underlying handle is gone — the close happens when the resource is
dropped, which is not ordered against the next statement. Then `chmod`, `rename`, and the test execs a
path whose inode this process may still hold open for writing.

Not `makeTempFile`, as this issue guessed: the rename replaces that inode entirely, and exec follows
the *name*, so the descriptor Deno might hold for the original is irrelevant by then.

The fix is to close it by hand — open, write, `sync()`, `close()` in a `finally`, then chmod and
rename. Pushed on 2026-08-05.

**It came back on the next run**, in `nc -l takes one connection` — same file, different test. So the
late close was not it, or not all of it. The two changes stay because both are right on their own
merits (and the hand-rolled write turned up a second bug in itself: `write` is POSIX `write` and may
take fewer bytes than it is given, so one call could truncate a 400 KB binary), but this issue is not
explained.

**What I measured, so the next person does not repeat it.** 360 build-and-exec rounds — three
variants × 120, in three concurrent processes, at load 8, with a realistic 400 KB shebang script:

| variant | ETXTBSY |
|---|---|
| open/write/sync/close, chmod, rename | 0 of 120 |
| `writeTextFile`, chmod, rename | 0 of 120 |
| `writeTextFile` straight to the destination, chmod, no rename | 0 of 120 |

Even the variant with no rename at all never failed, which says the plain write-then-exec pattern is
not the mechanism. Something else has that file open for writing, and it is not the obvious writer.

**Where I would look next**, in order: whether `deno` itself reopens the script it was handed (the
built artifacts are shebang scripts run through `deno run`, so the interpreter opens the same path the
kernel just execed); whether `Deno.Command().spawn()` differs from `.output()` here, since both
failures used a path that a *later* test also builds; and whether the file is executed while another
process in the same suite is executing it — `ETXTBSY` is symmetric, and the suite runs 8 files at a
time.
