# 0090 — a line the tests demonstrably execute is reported "not covered"

> Renumbered from 0089 by agent-b: two issues were filed as 0089 within an hour of each other, and the
> other one (a relay truncating uploads) was committed first, at 08:09 against this one's 08:55. The
> earlier number stands and the later moves, which is the only rule that does not need us to agree in
> advance. Commit 940f7e4 and anything else referring to "0089" for *this* issue means 0090.

- **Status:** closed
- **Claimed by:** agent-a
- **Reported by:** agent-a
- **Date:** 2026-08-06
- **Kind:** bug
- **Symptom:** wrong answer

`deno task mutate --operators --package std` scores **2 of 8** and reports two mutants as *not covered*:

```
  --  extreme/std/hash/i32Eq        not covered
  --  extreme/std/hash/i64Eq        not covered
```

"Not covered" means the profile knows the line and no test's hit set contains it — the runner then records
the mutant without running anything, and excludes it from the score.

**It is wrong.** Gutting the function by hand and running the package's own tests:

```
$ # export bool i32Eq(i32 a, i32 b) { return a == b; }  →  { return false; }
$ deno test --allow-all packages/std/
map: differential_weak_hash ... FAILED
FAILED | 29 passed | 8 failed
```

Eight tests notice. The line is executed by `packages/std/test/wac/map_test.wac`, which builds
`Map.create(hashI32, i32Eq)` in four separate cases.

## Why this matters more than a wrong number

`tools/mutate/profile.ts` says it out loud: **under-selection is a wrong verdict, over-selection is only
slow.** A mutant recorded as "not covered" is not run, so a real gap can hide behind it — and unlike a
survivor, it is excluded from the score rather than reported as untested behaviour. `packages/std` is the
package every other one imports.

The selection rule already has a guard for the shape that produced a similar false negative before
(`extreme/tls/client/tlsClientInit`), and it does not fire here: `i32Eq` is a one-line function, so the
whole edit span is the single line that carries its coverage point, `locations.every(known)` is true, and
the empty answer is trusted.

## What I think is happening, unverified

`packages/std`'s tests are mostly **wac-written** — `map_test.wac`, `vec_test.wac`, `option_test.wac` run
through `harness/wacTestRun.ts` — and the packages whose sweeps look healthy are mostly TypeScript-driven.
So the suspicion is that coverage executed by a wac-written test is not attributed to the Deno test that
wraps it: either the registration happens before `harness/wacProfile.ts` installs its wrapper, or the wac
bodies run at registration time rather than inside the wrapped test body.

Either would show up exactly like this: the line is *known* (it has a point, because the instrumented
module was built) and belongs to *no* test's set.

## What would settle it

Build the profile for `packages/std` and look for `packages/std/src/hash.wac:71` in `known` and in
`lines`. If it is in the first and not the second, the attribution is the bug rather than the selection.
Then check whether any line reached only by a wac-written test is ever attributed — if none are, the
answer is in `wacTestRun`'s relationship to the profiler's `Deno.test` wrapper.

## Notes

Found while working [0005](0005-mutation-testing-found-54-untested-behaviours.md)'s remaining packages.
Filed rather than fixed because it is in shared tooling and the fix depends on which of the two causes it
is — and because a sweep that under-selects is exactly the kind of thing that should be understood before
it is patched.

## Cause, found — and it is not attribution, it is that the build was never instrumented

`harness/wacTestRun.ts` compiled with `wacCompile(files, entry)` — no `{ coverage: true }` — and never
imported `harness/wacProfile.ts`. That is both halves at once:

- **no counters.** The module a wac-written test runs had no coverage points in it, so there was nothing
  to read either side of the test;
- **no wrapper.** `install()` is called by `registerProfiled`, which `wacBind` calls and this path did
  not, so `Deno.test` was never wrapped and the file wrote **no profile JSON at all**.

Measured directly, before the fix:

    WAC_PROFILE=<dir> deno test --allow-all packages/std/test/map.test.ts
    $ ls <dir>
    (empty)

So `packages/std/src/hash.wac:71` was in `known` — contributed by some *other* file's instrumented
build — and in no test's set, which the runner reads as "nothing executes this". Exactly the hypothesis
in the section above, one layer earlier than it guessed: not attribution lost between `wacTestRun` and the
wrapper, but a path that never joined the profile at all.

**Sixty-four test files register through `wacTestRun`.** Every line reached only by a wac-written test has
been invisible to selection since profiling was added — `packages/std` is simply where it was noticed,
because its tests are almost all wac-written.

## Fix

`wacTestRun` now does what `wacBind` does when `WAC_PROFILE` is set: compile with `{ coverage: true }`,
write to a `prof_`-prefixed cache path (the two builds are different binaries and a module is cached by
path), call `__cov_init`, and `registerProfiled` *before* declaring the tests so the wrapper is in place
when they are.

After, the same command writes a profile and eleven of the sixteen map tests are credited with
`hash.wac:71`.

`harness/wacTestProfile.test.ts` is the regression: it runs a real wac-written test file under a real
profile and asserts that the library's lines land in a *test's own* set, not merely in the file. Broken on
purpose against the historical code, it fails with `the instrumented build does not know hash.wac exists`,
which is the diagnosis rather than a symptom.
