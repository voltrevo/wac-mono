# 0041 — test harnesses leak a built binary per run, until a suite dies of a full disk

- **Status:** closed
- **Claimed by:** agent-a
- **Reported by:** agent-a
- **Date:** 2026-08-04
- **Kind:** bug
- **Symptom:** wrong answer

A push gate failed with five red tests in `packages/crypto`, none of which had anything to do with the
change being pushed:

```
error: No space left on device (os error 28): writefile
  '.cache/packages_crypto_test_wac_field25519_test.wac.gen.ts.…tmp'
```

`/tmp` held **517** `wacssh*` binaries, 157 `wac-ssh*`, 120 `wacsh*` and 113 `wacsh-spawn*` — about
340 MB of built executables, one or more per run of the suite, going back as far as the container does.
`Deno.test` has no suite-level teardown, so a module-level temp shared by several tests had nowhere to
be removed, and one file said so out loud: "The temp directory outlives the tests deliberately … which
the OS clears." It does not clear it.

## Why it matters more than the megabytes

The failure lands in an unrelated package, at a random point in a parallel run, with a message about
whichever file happened to be writing. It looks like a flake in `crypto`. This is the third time
disk exhaustion has produced a mystery red suite in one day — the first was `platform/app.ts` calling
`Deno.exit` inside a `try`, so its `finally` never removed 5,579 built binaries; the second was a
transient full disk making 68 tests fail at once.

## Fixed

`globalThis.addEventListener("unload", …)` in the five files that build without removing:
`ssh/test/cli.test.ts`, `ssh/test/server.test.ts`, `sh/test/spawn.test.ts`,
`sh/test/differential.test.ts` and `box/test/shell.test.ts`. `unload` fires whether the tests passed,
failed or threw, which is the only hook that covers all three — a `try/finally` per test cannot, since
the temp is shared by the file.

Verified by running those three packages and watching `/tmp`: one new entry across the run, where the
same run used to leave four.

## Notes for whoever hits this next

- `du -sh /tmp` and `ls /tmp | wc -l` first. A `df` taken *afterwards* shows plenty of room, because
  the thing that filled it has usually finished.
- A mutation sweep stages a copy of the repository per worker (`tools/mutate.ts`, `stageProject`), so a
  sweep and a suite together can take gigabytes that neither leaks.
- The pattern to copy is `box/test/box.test.ts`, which removes 58 of the 61 temps it makes.
