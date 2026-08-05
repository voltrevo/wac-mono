# 0082 — five tests fail, rather than slow down, when the machine is busy

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b
- **Date:** 2026-08-05
- **Kind:** bug
- **Symptom:** wrong answer

Under load these five fail, and they pass on a targeted re-run seconds later:

| test | file |
| --- | --- |
| `chunked bodies` | `packages/http/test/http.test.ts` |
| `malformed chunked bodies` | `packages/http/test/http.test.ts` |
| `fuzz: neither parser accepts what the other refuses` | `packages/http/test/fuzz.test.ts` |
| `fuzz: a second seed` | `packages/http/test/fuzz.test.ts` |
| `an endless producer stops at the cap rather than filling memory` | `packages/box/test/shell.test.ts` |

Observed at load average **6.7** on five cores, with another agent working. The full suite reported
`FAILED | 1159 passed | 5 failed` and took **2m07s**; the same commit, re-run at load 4.5, gave
`ok | 1164 passed | 0 failed` in **53s**. `packages/http` and `packages/box` on their own: 61 passed, 0
failed.

## A sixth, on the next run, with the mechanism named in the message

`packages/sh/test/differential.test.ts` failed at load 6.3 with:

    packages/sh/src/sh.wac did not load: did not report ready within 30000ms: a worker
    bundle that does not speak the bridge protocol, or a machine too loaded to have
    evaluated it

That message is good diagnostics — whoever wrote it anticipated exactly this — and it is a *different*
mechanism from the five above: a 30-second worker-readiness deadline rather than a body or fuzz budget.
It passed alone in 52s. The commit under test touched two markdown files in `issues/`.

So this is not one flaky test to fix but a class: every wall-clock deadline in the suite is a test that
fails when another agent is busy.

## Why this is worse than being slow

[0031](0031-a-mutation-sweep-starves-every-other-agent-on-this-machine.md) already records that another
agent's load stretches the suite. This is a different symptom with a worse consequence: the suite goes
**red**, so it accuses whatever change happens to be in the tree. I spent the first minutes of
diagnosis working out whether I had broken `packages/http`, having touched nothing in it — the only
reason I did not conclude I had is that my change could not plausibly reach those files.

Anyone whose change *does* touch http or box gets a failure they cannot distinguish from their own.

## What would settle it

These five are the timing-sensitive shapes: a chunked-body reader that presumably waits on a producer,
two seeded fuzzers with a time or iteration budget, and a cap test that races a producer against a
limit. A deadline expressed in wall-clock time fails under contention; the fix in each case is to make
the assertion about *what happened* rather than *how long it took* — count iterations rather than run
for N milliseconds, and drive the producer deterministically rather than waiting for it.

`harness/deadline.ts` already exists for bounded waits and its own note explains that a timeout with a
useless message is worse than none; the same reasoning applies to a timeout that fires from someone
else's load.

## Notes

Not a regression from anything in the tree today: the same commit passes at lower load, and the five
failing files are untouched by the commits around the observation.
