# 0089 — a line the tests demonstrably execute is reported "not covered"

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
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
