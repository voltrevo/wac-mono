# 0077 — a file named `test.ts` is run by the suite it launches

- **Status:** closed
- **Reported by:** agent-a
- **Date:** 2026-08-05
- **Kind:** bug
- **Symptom:** the host had to be rebooted

## Numbering

Filed as 0076 and renumbered the same hour: agent-b pushed *their* 0076 — an app worker running `main`
once per case — while this was being written, and they got there first. The slug is unchanged. Commit
`a1f5683` and the comments it added to `tools/runTests.ts`, `tools/suiteGuard.ts`,
`tools/discovery.test.ts` and 0031 all say 0076; they mean this file. Fixed in the sources below rather
than left to mislead, but the commit message cannot be changed.

## What happened

`deno task test` ran the suite. The suite ran the suite. Seventeen levels deep, load 122 on five cores
shared by three agents, and the operator rebooted the host VM.

```
$ ps -o pid,ppid,etimes -p $(pgrep -d, -f "deno test --parallel")
1033869  ppid=1033861  age=2298s     <- ppid is `deno run … tools/test.ts`, from tools/push.sh
1060819  ppid=1033869  age=2195s
1094805  ppid=1060819  age=2081s
   …                                    a new level about every 100 seconds, unbounded
1474652  ppid=1456358  age=85s
```

## Why

`tools/test.ts` was a wrapper: it capped `DENO_JOBS` and then spawned `deno test --parallel …`. It was
added for good reasons ([0075](../open/0075-the-test-worker-cap-is-a-guess-and-needs-a-quiet-machine-to-set.md)).

`deno test` with no paths walks the working directory and imports every file matching
`*_test.{ts,tsx,mts,js,mjs,jsx}`, `*.test.{…}` **or bare `test.{ts,js,mjs,mts}`**. That third pattern is
the one nobody remembers. So the suite imported `tools/test.ts`, and importing a module runs its top
level, and its top level launches a suite.

Confirmed rather than reasoned about, in a scratch directory with two files:

```ts
// test.ts
Deno.writeTextFileSync("collected-me", "yes");
// real.test.ts
Deno.test("a real test", () => {});
```

```
$ deno test --parallel --allow-read --allow-write
Check test.ts
./real.test.ts => a real test ... ok
ok | 1 passed | 0 failed
$ ls
collected-me  real.test.ts  test.ts
```

Deno type-checked *and executed* `test.ts` while reporting one test from the other file. `test.ts`
declares no tests, so it never appears in the output.

## Why nobody noticed for forty minutes

Every generation inherited the same stdout, so the log read as one very slow suite — 14,000 `ok` lines
and no summary — rather than as forty suites interleaved. From outside, "the machine is loaded and the
suite is slow" and "the suite is forking itself" look identical, which is the same confusion
[0031](../open/0031-a-mutation-sweep-starves-every-other-agent-on-this-machine.md) documents for sweeps.
The process tree was the only place the truth showed, and I read it late.

I also mis-attributed it twice in 0031 — first to a mutation sweep, then to another agent's checkout —
before checking `/proc/<pid>/cwd` and finding my own workspace. That correction is in 0031.

## The fix

1. **`tools/test.ts` → `tools/runTests.ts`**, and `deno.json`'s task with it. A wrapper's name must not
   be one the runner collects.
2. **`tools/discovery.test.ts`** asserts the property: every file in the repo that `deno test` will
   import declares a test, either directly or through `wacTestRun`, which registers one per exported
   `test_*` function. A second case in that file guards the guard — if the patterns it checks drift from
   Deno's, the first case would pass while measuring nothing.
3. The cache guard that lived in `tools/cacheGuard.sh` moved into `runTests.ts` as well, so `push.sh`
   calls the same implementation rather than a shell copy of it.

## What I would do differently

**Kill first, diagnose after.** I saw depth two, then seven, then ten, and kept investigating while it
grew, because each individual step was reasonable and none of them was "stop the thing". A process tree
that is deepening is not evidence to be gathered carefully; it is a fire.

And **`/proc/<pid>/cwd` before naming anyone.** Two agents' checkouts had chains, the shared file was the
cause, and I wrote an issue note blaming a colleague for a tree that turned out to be mine.

## A wrong diagnosis inside the fix (agent-a, 2026-08-05)

The guard above went into all four suite-spawning tools, and the next gate run failed after nine seconds.
I concluded that a top-level `Deno.exit` in `mutate.ts`, `testChanged.ts` and `mutate/profile.ts` was
killing whatever imported them, removed those three calls, and wrote that reasoning into the code and the
commit message.

**It was wrong.** Nothing imports those three — checked afterwards with `rg` over every `*.test.ts` — and
a full suite with the calls restored passes 1134 tests. The guard was innocent. What I had actually done
was pattern-match on the bug I had just spent an hour on: a top-level side effect run by something that
only meant to read the file. Having a fresh, vivid failure mode makes the next unexplained failure look
like it.

**What that nine-second failure was is still unknown**, and the evidence is thin because the run said
almost nothing. `deno test` type-checked all 140 files, printed the last `Check` line, and exited non-zero
with no diagnostic and no test output. The machine had rebooted fifteen minutes earlier and other agents
were rebuilding their caches, so a child killed for memory is the likeliest explanation — two workers plus
a type-check of the whole repo is the heaviest moment of a run.

`tools/push.sh`'s own branches rule out two of the candidates: 124 and 137 have their own message, and
this took the generic one, so the code was something else — probably 1. Deno exiting 1 immediately after
type-checking with nothing printed is what a `--parallel` worker dying looks like from outside, and
[0075](../open/0075-the-test-worker-cap-is-a-guess-and-needs-a-quiet-machine-to-set.md) has already seen
exactly that: a worker killed for memory, reported as though the test were wrong. That is why the cap
exists.

`push.sh` now prints the exit code, and says so explicitly when a failing run contains no failures —
because a gate that reports *that* the suite failed and nothing about how leaves a guess as the only
available diagnosis. That is the actual lesson: the gate reported *that* the suite failed and nothing about how,
so the only diagnosis available was a guess, and I made a confident one.
