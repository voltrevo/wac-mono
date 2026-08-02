# 0001 — the compiler is an unpinned dependency, and a stale one blames the wrong package

- **Status:** closed
- **Fixed in:** this commit
- **Claimed by:** agent-a
- **Reported by:** agent-b
- **Date:** 2026-07-31
- **Kind:** bug
- **Symptom:** compile error, attributed to the wrong place

`deno.json` maps `wac/` to `../wac/atoms/wac/` — whatever happens to be in the sibling
checkout. Nothing records which compiler this repo expects, so a checkout at the wrong
commit produces failures in packages that are not the cause, and the person who pulls
cannot tell.

This has cost time twice, in both directions:

- **Stale checkout.** A compiler six commits behind lacked `51e8cb9` (`string +=`
  emitted `f64.add`). `wactest` and `gzip`'s wac-written tests failed with
  `CompileError: f64.add[0] expected type f64, found struct.get` — a message that
  points at those packages and mentions nothing about compiler versions. Twenty minutes
  went into the wrong package before pulling `wac` fixed it.
- **Fresh checkout.** After `e64e47d` (an enum has no default value), `packages/wacc`
  stopped compiling. The suite was red for anyone who pulled, and the failure looked
  like wacc's until you knew about the compiler change.

Both were real and neither was the fault of the package that failed.

## Reproduction

```sh
cd ~/<agent>/workspaces/wac && git checkout HEAD~10
cd ../wac-mono && deno task test
```

Failures appear in whichever packages happen to use the affected feature.

Expected: something says "this repo expects wac at or after X", or the failure names
the compiler.
Actual: nothing records the expectation.

## Notes

Cheapest fix that would have caught both: record the expected commit and check it.
A `wac-version` file plus a few lines in `harness/wacBind.ts` — compare against
`git rev-parse` in the sibling checkout, or against a marker the compiler exports —
and fail with "wac-mono expects wac ≥ X, found Y" instead of a type error in someone
else's package.

That trades one maintenance chore, bumping the expected commit when adopting a
language change, for the failure naming its own cause. Given three agents pulling
independently, that looks worth it.

A weaker version costing nothing: a line in `README.md` under Commands saying to pull
`wac` first when a package fails to compile. That is not a fix, but it is where people
look.

## Fix (agent-a, 2026-08-02)

The cheapest option in the notes, built as described: `wac-version.json` records the
oldest compiler this repo is known to work with, and `harness/wacVersion.ts` checks it on
the first `wacBind` of a run. The reproduction in this issue now prints

```
wac-mono needs a newer compiler.
  expected: wac at or after 4ea0045 — trace mode (ctTrace) and the 'index'
            coverage-point kind, which packages/crypto's constant-time tests need
  found:    4922c33 in /home/claude/<agent>/workspaces/wac
  fix:      git -C ... merge origin/master
```

instead of a `CompileError` in whichever package happened to use the new feature.
Verified by pointing `deno.json` at a worktree of wac before the pinned commit and running
a **gzip** test — the package that took twenty minutes of the wrong investigation the
first time this happened.

Three decisions worth recording, because each could reasonably have gone the other way:

**A minimum, not an exact version.** `merge-base --is-ancestor`, not hash equality: being
ahead of the pin is the normal state, and making every wac push a wac-mono failure would
have people deleting the check within a day.

**Quiet when it cannot answer.** No git, no repo, a vendored copy — the check returns
rather than failing. A check that cannot run is not evidence of a problem, and turning
someone's unusual setup into a hard error would make this the thing that costs the
afternoon.

**The reminder is automatic.** Forty commits ahead and every run prints one line
suggesting `deno task wac:pin`. The operator asked for something to keep the pin current,
and a documented chore nobody is prompted to do is a chore nobody does. Verified by
temporarily pinning 60 commits back: *"note: wac is 95 commits ahead of the pin"*.

`deno task wac:pin` records the sibling HEAD. It refuses a dirty wac tree and refuses to
move the floor backwards, but it cannot check that the suite passes — so README.md states
the order: pull, test, *then* pin.

Not fixed here: nothing stops someone pinning to a compiler the suite has never run
against. That needs the pin to be written by CI rather than by hand, and there is no CI.
