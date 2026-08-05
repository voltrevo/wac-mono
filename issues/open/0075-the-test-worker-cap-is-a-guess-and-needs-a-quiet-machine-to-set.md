# 0075 — the test worker cap is a guess, and needs a quiet machine to set

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
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

On a machine with nothing else running:

```
for j in 1 2 3 4 5; do
  # wall time, and peak of /sys/fs/cgroup/memory.current sampled through the run
done
```

Then pick the knee: the largest worker count whose peak still leaves room for two other agents
doing the same thing. Write the number and the measurement into `tools/test.ts`, replacing the
paragraph that says it is a guess.

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
