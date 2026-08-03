# 0024 — mutation test-selection is inert for subprocess tests, and the fallback runs them worst-first

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b
- **Date:** 2026-08-03
- **Kind:** performance
- **Symptom:** wrong answer

Two separate things, and the second is cheap to fix and probably the bigger win.

## 1. Per-test selection cannot see subprocess tests

`harness/wacProfile.ts` attributes lines to tests by wrapping `Deno.test` and reading wac's
coverage counters **in-process**. That works only for a test that drives wac through `wacBind`.
A test that builds a standalone binary and runs it as a child has its counters *in the child*, so
it contributes nothing — and the profile cannot tell "this test reaches no lines" from "this test
was never measured".

| test file | attributable |
| --------- | ------------ |
| `packages/ssh/test/transport.test.ts` | yes — `wacBind` |
| `packages/ssh/test/server.test.ts` | no — builds a binary, drives real OpenSSH |
| `packages/ssh/test/cli.test.ts` | no — same |
| `packages/sh/test/differential.test.ts` | no — builds a binary, runs ~500 scripts through bash |
| `packages/sh/test/spawn.test.ts` | no — builds a binary and a worker bundle |

The effect is stated by the tool itself and is easy to read past:

```
selection: 0/117 mutant(s) ran only the tests that reach them, 117 fell back to the full scope
```

That is `--package sh`, where **every** test is subprocess-based, so the headline optimisation
contributed exactly nothing. `ssh` is better only in that one of its three files is attributable.

This is structural rather than a misconfiguration — you cannot read a counter that lives in
another process. Fixing it properly means a built binary dumping its counters on exit when
`WAC_PROFILE` is set, which is work in `packages/platform`'s build path, not in the harness.

## 2. The fallback runs the most expensive tests first

This is the cheap one. When selection returns `null`, `testDirs` hands `deno test` a **directory**:

```ts
return [...pkgs].sort().map((p) => `packages/${p}`);
```

Deno then discovers the files itself, in its own order, which for `packages/ssh` is alphabetical:
`cli.test.ts`, `server.test.ts`, `transport.test.ts`. So the single cheap in-process suite runs
**last**, after both suites that spawn a real OpenSSH client.

`--fail-fast` is already on, and for exactly the right reason — its comment says "killing needs one
failing test, and almost every mutant is killed, so running the rest of the suite afterwards is
pure waiting". But fail-fast only pays when something fails *early*. A mutant in `wire.wac` or
`packet.wac` that `transport.test.ts` would kill in milliseconds currently pays for the full
handshake suites first.

Rough shape of the cost, from isolated runs earlier today (not measured under the sweep, because
these tests bind ports and a clash would corrupt live verdicts):

- whole `packages/ssh` suite: ~19s, 38 tests
- `server.test.ts` alone: ~13s, 4 tests
- so `transport.test.ts` + `cli.test.ts` together: ~6s, and transport is the bulk of the *tests*
  while being a small share of the *time*

### Suggested fix, in order of value

**Order the files cheapest-first and pass files rather than a directory.** `buildProfile` already
runs each test file as its own `Deno.Command`; timing it there is free, and the order can be
cached alongside the profile. Cheapest-first is a strict improvement under fail-fast and changes
no verdict, because a killed mutant is killed whichever test kills it.

**Then bias by likelihood, which is the "hint" idea.** Where attribution exists, put attributed
tests first. Where it does not, a decent proxy is proximity — a mutant in `packages/ssh/src/wire.wac`
is most likely killed by the test file whose name shares the most path with it, and unit-style
files beat integration ones. This only reorders; it never excludes, so it cannot cause a false
survivor the way narrowing can.

**Only then consider the subprocess attribution in (1).** It is much more work and the ordering
change may capture most of the benefit.

## Notes

Worth being explicit about the asymmetry, because it decides how safe each change is:
**under-selection is a wrong verdict, over-selection is only slow.** `profile.ts` already says
this and it is why the fallback exists. Reordering is safe on that test; excluding is not.

The tool's header should also say that selection is inert for subprocess-based suites, so the next
person reading `0/117` knows it is a property of the tests and not a bug in the run.
