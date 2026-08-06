# 0024 — mutation test-selection is inert for subprocess tests, and the fallback runs them worst-first

- **Status:** closed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b
- **Date:** 2026-08-03
- **Kind:** performance
- **Symptom:** wrong answer

Two separate things. I originally wrote that the second was "cheap to fix and probably the bigger
win"; it is cheap and it is done, and measured it is worth about a tenth. The first is the large
one and is still open. Both claims below are now numbers rather than expectations.

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
contributed exactly nothing.

**Correction to the first version of this issue, which overstated the reach of the problem.** I
implied `ssh` was in similar shape. It is not — measured, it narrows most of its mutants:

```
ssh:  88/154 narrowed, 51 fell back     (before the ssh test work of 2026-08-03)
ssh: 100/151 narrowed, 38 fell back     (after)
sh:    0/117 narrowed, 117 fell back
```

One attributable file is enough when it covers enough lines: `transport.test.ts` accounts for
1022 covered lines, so two thirds of `ssh`'s mutants can be narrowed even though the two
integration suites contribute nothing. The problem is real and total for `sh`, and partial for
`ssh`. Worth being precise about, because it changes which fix matters: for `sh` nothing but
subprocess attribution will help, while for `ssh` the ordering below is most of the win.

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

**Done, 2026-08-03: order the files cheapest-first and pass files rather than a directory.** `buildProfile` already
runs each test file as its own `Deno.Command`; timing it there is free, and the order can be
cached alongside the profile. Cheapest-first is a strict improvement under fail-fast and changes
no verdict, because a killed mutant is killed whichever test kills it.

**Still open: bias by likelihood, which is the "hint" idea.** Where attribution exists, put attributed
tests first. Where it does not, a decent proxy is proximity — a mutant in `packages/ssh/src/wire.wac`
is most likely killed by the test file whose name shares the most path with it, and unit-style
files beat integration ones. This only reorders; it never excludes, so it cannot cause a false
survivor the way narrowing can.

**Still open, and the only thing that helps `sh`: the subprocess attribution in (1).** It is much more work and the ordering
change may capture most of the benefit.

## Notes

Worth being explicit about the asymmetry, because it decides how safe each change is:
**under-selection is a wrong verdict, over-selection is only slow.** `profile.ts` already says
this and it is why the fallback exists. Reordering is safe on that test; excluding is not.

The tool's header should also say that selection is inert for subprocess-based suites, so the next
person reading `0/117` knows it is a property of the tests and not a bug in the run.

## What the ordering change did, measured

`buildProfile` already runs each test file on its own, so timing it is free; `byCost` sorts on
that and the runner passes the files instead of the directory. The order it found in `ssh` is the
exact reverse of alphabetical, which is what `deno test <dir>` was using:

```
order: transport.test.ts 2240ms -> server.test.ts 5837ms -> cli.test.ts 12175ms
```

So a mutant that `transport.test.ts` kills used to pay 18 seconds of real OpenSSH handshakes
before reaching the suite that would kill it in two.

Verdicts are unchanged — 135/151 killed, the same three survivors, the same 13 not covered —
which is the property that makes ordering safe where narrowing is not: it can only change how
long a verdict takes, never what it is.

**And it is worth 9.5%, not the multiple I predicted.** Two runs of identical code, ordering the
only difference, back to back on an otherwise idle box:

```
A  cheapest-first   666s   135/151 killed   100/151 narrowed
B  directory order  736s   135/151 killed   100/151 narrowed
```

The reason is in the third column and I should have seen it before predicting: **selection already
narrows 100 of the 151**, so ordering can only affect the 38 that fall back. Of those, the three
survivors and thirteen uncovered gain nothing by construction — a survivor runs every test
whatever the order — and some of the remainder are killed by `cli` or `server` anyway. The
18-seconds-per-mutant saving applies to far fewer mutants than the raw file costs suggest.

A ran first and warmed the caches, which biases toward B, so the real gap is if anything slightly
wider than 9.5% — not narrower.

Worth keeping anyway: it is free at run time, it cannot change a verdict, and it will matter more
in a package where selection cannot narrow. But it is not the fix for this issue. The fix for this
issue is subprocess attribution, and `sh` at 0/117 is where that shows.

## Closed, 2026-08-06 (agent-a): a built program dumps its own counters

The remaining item — "the only thing that helps `sh`" — is done, and this issue's own description of the
fix was the right one: *"a built binary dumping its counters on exit when `WAC_PROFILE` is set, which is
work in `packages/platform`'s build path, not in the harness."*

**Measured, `packages/sh`:**

| | before | after |
| --- | ---: | ---: |
| tests the profile can attribute | 0 | **31** |
| source lines with at least one test | 0 | **1606** of 2079 known |

576 of those lines are in `exec.wac` and 446 in `program.wac`, which is where sh's mutants live. The
`0/117` this issue is named for was a property of the tests; it is not one any more.

### How it works, in four places

- **`packages/platform/build.ts`** compiles instrumented whenever `WAC_PROFILE` is set. That is what makes
  every existing subprocess test attributable *without editing any of them* — they all build through here.
- **`host/entry.ts`** and **`host/entryNode.ts`** call `__cov_init` before `main` and dump after it, on
  success or failure. A failed run matters most: a mutant that makes a program crash is killed by whichever
  test ran it, and that is exactly the test the attribution needs.
- **`harness/wacProfile.ts`** collects whatever dumps appeared while a test was running and credits them to
  that test, taking them away as it reads.
- The dump carries `file:line`, resolved at build time, so neither end needs the other's point table.

### Three things this got wrong first, all found by running it rather than reasoning about it

- **A scoped `--allow-write` narrowed a program that already had write access.** Deno takes the scoped list
  rather than the union, so `--allow-write=<dump> --allow-write` left `wacsh` able to write its dump and
  nothing else — `rm` then failed with "Requires write access", inside a test asserting on what `rm` says
  about a file it cannot name. The flag is only added when the program has no write grant of its own.
- **The Node worker never called `__cov_init`**, so an instrumented Node build trapped on its first branch
  with `dereferencing a null pointer`. Half a contract implemented is worse than none: the Deno build
  worked, so nothing looked wrong until `node_shell.test.ts` was profiled.
- **The wrapper was installed too late for the tests that needed it most.** `node_shell.test.ts` and
  several in `platform` reach `build.ts` only through a dynamic `import()` *inside a test body* — by then
  `Deno.test` has already registered the case, so the wrapper wrapped nothing and the file wrote no profile
  at all. It would have looked exactly like the problem this issue is about. `harness/spawnRetry.ts` is the
  hook now: every subprocess test imports it, statically, at the top.

**The browser target is not instrumented**, and that is a decision rather than an oversight: a page has no
filesystem to dump into, so it would cost bundle size and buy nothing — and an instrumented module whose
`__cov_init` is never called does not start at all.

`packages/platform/test/subprocess_profile.test.ts` drives the whole chain — a real profile run over a
real test file that only talks to a subprocess — because a unit test of any single link would pass while
the chain was broken. The dump directory is spelled in two files that do not import each other, which is
exactly the kind of agreement that rots.

### What is left, and it is not implemented rather than approximated

The **"bias by likelihood" ordering** from the list above. Ordering by measured cost is in, and it is worth
9.5%; ordering by proximity — a mutant in `wire.wac` is likeliest killed by the test whose name shares the
most path with it — is not written. It only reorders, so it cannot cause a false survivor, but with
attribution now working for the packages that had none, the fallback path it improves is much narrower than
it was. Worth doing when there is a measurement showing it helps; there is not one today.