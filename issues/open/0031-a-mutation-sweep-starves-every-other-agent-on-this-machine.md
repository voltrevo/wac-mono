# 0031 — a mutation sweep starves every other agent on this machine

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-a
- **Date:** 2026-08-04
- **Kind:** performance
- **Symptom:** wrong answer

`deno task test` is about fifty seconds. Twice today it has taken **over half an hour**, and both
times the cause was a mutation sweep running in another agent's workspace. Filed rather than fixed
because the change belongs in `tools/mutate.ts`, whose timeout scoring I do not want to alter while
somebody else is mid-sweep — see the note at the end.

## What it looks like

While `deno task mutate --package unicode --operators=all` was running next door:

```
$ cut -d' ' -f1-3 /proc/loadavg && nproc
10.55 6.97 4.97
5
```

Five cores, load ten. My suite ran; it just took forty times as long, which from the outside is
indistinguishable from a hang — I killed a run at thirty minutes believing the suite had deadlocked,
and then spent an hour proving it had not (every one of the 140 test files passes alone; the four
heaviest packages in one process take 79 seconds).

## Why the sweep is heavier than it says it is

`mutate.ts` caps itself at `min(4, cores - 1)` jobs, which sounds polite. But a *job* is a whole
`deno test` invocation over a scope, and several of this repo's test files are themselves swarms of
subprocesses: `packages/box/test/box.test.ts` spawns about three hundred built binaries, each one a
`deno` process plus a worker. Four concurrent jobs over a scope that includes `box` is therefore
hundreds of processes, not four. Add another agent's ordinary suite and the machine is oversubscribed
by an order of magnitude.

## What would fix it

Three candidates, in the order I would try them:

1. **Count cores, not jobs.** `--jobs` should mean "at most this much of the machine", so a scope
   whose tests spawn subprocesses should count for more than one. Even a crude version — jobs = 1
   when the scope includes `packages/box` or `packages/sh` — would remove most of the harm.
2. **Yield to interactive work.** A sweep is background work by nature; a suite someone is waiting
   on is not. `nice` would express that exactly. **The catch is scoring**, and it is why this is
   filed rather than done: a mutant that exceeds `TEST_TIMEOUT_MS` is scored as *killed*, so making
   mutants slower under load manufactures false kills — the sweep would report better numbers for
   being nicer, which is the worst direction for a measurement error. Nicing wants the timeout to be
   relative to the baseline run in the same conditions, which `mutate.ts` already measures per scope.
3. **Refuse to start on a loaded machine**, or wait for the load to fall. Crude, honest, and one
   `/proc/loadavg` read.

## Notes

`tools/push.sh` now prints the load and the elapsed time around every run, and says so when a run
took several times the usual, so the next person to see this does not have to guess. That is a
diagnostic, not a fix.

Not a wac issue and not a test issue: nothing here is broken. It is one shared machine and a tool
that assumes it has the whole of it.

## Not this issue after all: the nested suites were a runaway, and mine (agent-a, 2026-08-05)

I annotated this issue twice today with process trees showing `deno test --parallel` nested seven and
then ten levels deep at load 103 and 122, and attributed them to a mutation sweep in another agent's
checkout. **Both attributions were wrong in the way that matters, and the second was wrong outright.**

The cause was not a sweep and not `mutate.ts`. `tools/test.ts` — the wrapper that caps the worker count
— was collected *as a test module* by the suite it launches, because `deno test` imports bare
`test.{ts,js,mjs,mts}` as well as `*_test.ts` and `*.test.ts`. Every generation of the suite executed its
top level and started another generation, about a hundred seconds apart, unbounded. The first tree I saw
was in agent-b's checkout; the second, which I described here as a recurrence in their checkout, was in
*mine* — my own push gate, which I left running for forty minutes while investigating. The host had to be
rebooted.

Written up as [0077](../closed/0077-a-file-named-test-ts-is-run-by-the-suite-that-launches-it.md), which
has the reproduction and the fix. Nothing about it belongs to this issue, and the numbers above should
not be read as evidence about mutation sweeps: load 122 was self-inflicted.

What this issue's own claim still rests on is the 2026-08-04 observation at the top — an
`--operators=all` sweep next door taking a fifty-second suite to over half an hour — which was measured
before any of today's confusion and is unaffected.

