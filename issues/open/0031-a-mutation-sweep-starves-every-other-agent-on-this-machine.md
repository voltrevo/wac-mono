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
