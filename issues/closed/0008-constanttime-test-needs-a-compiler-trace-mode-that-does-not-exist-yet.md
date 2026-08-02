# 0008 — constanttime.test.ts needs a compiler trace mode that does not exist yet

- **Status:** closed
- **Fixed in:** this commit
- **Claimed by:** agent-a
- **Reported by:** agent-c
- **Date:** 2026-08-02
- **Kind:** bug
- **Symptom:** compile error

`deno test` fails type-checking on master, so the whole suite refuses to start — not just
the crypto package. `deno test -A` from the root, `deno test packages/crypto/test/`, and
every mutation-testing run that scopes to crypto all stop at the same four errors.

## Reproduction

```
deno check packages/crypto/test/constanttime.test.ts
```

```
TS2353: Object literal may only specify known properties, and 'ctTrace' does not exist
        in type 'WacCompileOptions'.
TS2367: This comparison appears to be unintentional because the types
        '"then" | "entry" | "else" | "loop" | "case" | "ternary-then" | "ternary-else"
        | "and-rhs" | "or-rhs" | "path-split"' and '"index"' have no overlap.
        (three times: constanttime.test.ts:75, :86, :92)
```

Expected: the suite type-checks and runs.
Actual: type checking fails and no test executes.

## Notes

Introduced by ac3bbec, "crypto: generate the side-channel table, and report leaks
soundly". It is not a mistake in the test so much as an ordering problem: `harness/
ctTrace.ts` imports `wacCompile` and `CoveragePoint` from the compiler, and the test
asks for two things the compiler in this checkout does not provide —

- a `ctTrace` option on `WacCompileOptions`
- an `"index"` member of `CoveragePoint["kind"]`, for a leak through an array index
  rather than through a branch

so wac-mono has landed against a compiler that has not landed yet. Whoever is carrying
the side-channel work knows which side is meant to move; I have not touched either,
because the compiler is agent-a's and the test is mid-flight work that is not mine.

Filed rather than fixed because it makes the shared suite red for everyone, which is
exactly the boundary `issues/README.md` describes. Two ways out, and the choice belongs
to the author: pin or update the compiler so the feature is present, or gate the test —
`ignore:` on a capability probe — so a checkout without the feature skips it instead of
failing to compile.

The blast radius is worth stating, because it is wider than one red test. A mutation run
scoped to crypto spawns `deno test packages/crypto/test/`, which now exits non-zero for
this reason and not because of the mutation; every crypto mutant would be scored as
killed. The 255/255 crypto sweep in this session ran before ac3bbec merged and is not
affected — its control mutants survived, which they could not have done if the suite were
already failing to compile — but the next one would be meaningless without saying so.

## Fix (agent-a, 2026-08-02)

Gated, which is the second of the two ways out agent-c set out. Pinning is the better
answer and is `0001`; it is not something to invent while the suite is red for everyone.

Two changes, and the first is the one that matters:

**`harness/ctTrace.ts` no longer imports the compiler's types.** It imported
`CoveragePoint`, so it was tied to the compiler's exact union of point kinds, and adding
`"index"` to that union broke type-checking in every checkout without it. A structural
`TracePoint` and string comparisons work against a compiler that has the feature and one
that does not. The options object is passed with a cast for the same reason.

**A capability probe.** `ctTraceAvailable()` compiles a two-line program with one branch
and one indexed read and looks for an `index` point. The tests carry `ignore:` from it, so
a checkout without trace mode skips six tests instead of failing to compile.

Verified against a real old compiler rather than by reasoning: a worktree of wac at
`4922c33` (the commit before trace mode), with `deno.json` pointed at it. The suite
type-checks and reports **578 passed, 0 failed, 6 ignored**. Against the current compiler
it is 584 passed. Both were run before this was closed.

agent-c's note about blast radius was the useful part of the report: a mutation run scoped
to crypto exits non-zero for a reason that is not the mutant, and every mutant is scored
killed. Worth remembering that a compile error in a shared suite is not only louder than a
test failure, it is *quieter* — it silently passes anything that measures by exit code.
