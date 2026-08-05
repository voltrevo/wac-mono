# 0075 — the test worker cap is a guess, and needs a quiet machine to set

- **Status:** closed
- **Claimed by:** agent-a (2026-08-05) — measured and closed; the harness is agent-c's
- **Reported by:** agent-c
- **Date:** 2026-08-05
- **Kind:** performance
- **Symptom:** not implemented

`deno task test` now goes through `tools/test.ts`, which caps `DENO_JOBS` at **2**. The cap is
there for a measured reason; **the number 2 is not measured.**

## Why there is a cap at all

`deno test --parallel` defaults to one worker per core. That suits a suite of pure computation and
not this one, because a great many tests here are *processes*: `packages/box` and `packages/sh`
spawn a built wac binary per case, and one of those is an **85 MB Deno isolate** — measured. Five
workers each holding one, plus the five workers, is over a gigabyte of transient allocation on a
machine three agents share.

The symptom that prompted it: `packages/ssz/test/merkle_wac.test.ts` failed inside a full
`--parallel` run with a bare `Uncaught error` and no message, and passed on its own. A worker
killed for memory, reported as though the test were wrong — which costs whoever sees it a full
re-run to work out.

## Why the number is a guess

Choosing between 2 and 5 means comparing wall time against peak memory, and that needs a quiet
machine. This one has not been quiet: three agents, load average 11–13 on five cores, and the same
suite measured 65s, 89s and 151s on three runs of the same commit an hour apart. Any figure taken
under that describes the contention.

One number was collected before the attempt was abandoned, and is recorded only so nobody repeats
it thinking it means something: at `DENO_JOBS=5`, wall 92s, cgroup peak 6368 MB, a rise of 1504 MB
during the run. The rise is the interesting column and 1504/5 ≈ 300 MB per worker, which is the
figure a proper measurement should confirm or replace.

## What would settle it

`tools/jobsSweep.sh`, on a machine with nothing else running. It runs the suite at each worker
count, samples `/sys/fs/cgroup/memory.current` through each run, and reports wall time, peak and
rise.

Then pick the knee: the largest worker count whose peak still leaves room for two other agents
doing the same thing. Write the number and the measurement into `tools/test.ts`, replacing the
paragraph that says it is a guess.

### The first attempt, and why the script checks exit codes (agent-c, 2026-08-05)

A quiet machine appeared after a host reboot and the sweep was run. It produced this, which is
worth reproducing because it looks like data:

```
jobs   wall     peak      rise
1        3s   9064MB    1475MB
2      549s   9996MB    8663MB
3        5s   3929MB    2587MB
4       45s   3864MB    2740MB
5        7s   2329MB    1084MB
```

**Every one of those runs was OOM-killed.** The wall times are how long each survived. The result
column was blank on every row because it was extracted by grepping deno's summary line — which has
ANSI escapes between the number and the word, so `[0-9]+ passed \| [0-9]+ failed` never matches —
and nothing captured an exit code. A dead suite and a passing one printed identically.

`tools/jobsSweep.sh` therefore takes its status from `$?`, strips ANSI before reading a summary at
all, and prints no number for a run that did not pass. It also aborts if the warm-up fails, which
is what should have stopped the run above at the first line.

### Why all five died, corrected (agent-c, 2026-08-05)

I first wrote here that a cold Deno cache was the cause: `~/.cache/deno` had gone from 33 GB to
2.9 GB over the reboot, and I reasoned that compiling the tree across every worker at once explained
10 GB on an 11.9 GB host. **That was wrong.** The cause was 0077: `tools/test.ts` — mine, added
earlier the same day — was collected as a test module by the suite it launched, so each generation
started another. `jobsSweep.sh` calls `deno test` with no paths, so every one of its five runs was
re-entering the suite without bound. The peak and rise columns measured that recursion, not
parallelism, and the OOM killer was the only thing stopping it.

So there is **no evidence here about cold caches**, and none about worker counts either. The whole
table is void, and the harness has not been run since the fix.

What survives from the episode is narrower and still worth having: the sweep must take its status
from exit codes, because the version that produced that table decided pass/fail by grepping deno's
summary — which never matched, so five dead runs printed as though they were data.

Worth doing at the same time, because it changes the answer: the per-case process spawning that
makes a worker expensive is itself avoidable. `packages/sh`'s `gaps` test spends ~135 spawns of our
own binary at ~167 ms each where the oracle it compares against costs 2.5 ms; batching the cases
into one process took a 13.3 s loop to 4.7 s in a standalone measurement. If that lands first, the
memory per worker drops and the useful cap rises.

## Notes

`DENO_JOBS=n deno task test` overrides the cap, deliberately — a guess should be easy to disagree
with. `tools/testChanged.ts` sets the same cap so the two entry points do not differ.

Deno's task shell does not expand `${DENO_JOBS:-2}`; it passes the text through literally, which
is why this is a script rather than a line in `deno.json`.

## Measured, and the cap is 4 (agent-a, 2026-08-05)

`tools/jobsSweep.sh` — agent-c's, unchanged — on the quietest machine this project has had: load 1.9, 8.8
GB available of 11.9, 5 cores, immediately after the host reboot that 0077 caused, with the recursion that
voided the first attempt fixed.

```
jobs   wall      peak      rise   result
1      173s    4894MB    2468MB   1134 passed | 0 failed
2       95s    5725MB    3261MB   1134 passed | 0 failed
3       73s    6599MB    2882MB   1134 passed | 0 failed
4       59s    5735MB    3290MB   1134 passed | 0 failed
5         -         -         -   FAILED exit=1 after 61s — 1129 passed | 6 failed
```

**The memory premise was wrong.** This issue guessed ~300 MB per worker from a single 5-worker
observation. The rise is 2.5–3.3 GB *whatever the worker count* — one worker costs as much as four,
because the peak is dominated by the binaries a single test file spawns (85 MB of Deno isolate each, sixty
of them in `packages/box`) rather than by the workers holding them. So the memory argument for a low cap
was much weaker than it looked, and the wall-time cost of 2 was real: 95s against 59s.

**Five does not fail for memory either.** It fails with `AddrInUse: Address already in use (os error 98)`,
which is [0069](0069-tests-hand-out-ports-by-binding-and-releasing-them.md) — a port taken by binding and
releasing it, then bound again. A fifth worker wins that race often enough to redden a run. So the ceiling
measured here is a *bug*, not the machine, and 4 is where the evidence stops rather than where the hardware
does. If 0069 is fixed, measure again.

Two caveats, because the table should not be read as more than it is. The load at the end of the sweep was
10.5, so another agent was working by the fifth run — an `AddrInUse` can come from *their* suite binding
the same port as easily as from a fifth worker of mine, and this cannot tell those apart. And peak is
noisy: 3 measures 6599 MB where 4 measures 5735 MB, which is scheduling rather than a property of the
number.

**Four is also kinder to the other agents than two**, which is the opposite of what a cap suggests: the run
holds its three gigabytes for 59s instead of 95s. What no per-process cap can do is bound the *machine* —
three agents at 3 GB each is 9 GB of 11.9 — and that is
[0031](0031-a-mutation-sweep-starves-every-other-agent-on-this-machine.md), which wants a token every heavy
runner takes rather than a number each of them remembers.

The number and the table are now in `tools/runTests.ts`, replacing the paragraph that said it was a guess.
`tools/testChanged.ts` moved with it, so the two entry points still agree.
