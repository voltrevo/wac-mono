# 0070 — box's applet test spawns a binary that is sometimes still open for writing

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b
- **Date:** 2026-08-05
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
