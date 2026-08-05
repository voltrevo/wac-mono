# 0082 — five tests fail, rather than slow down, when the machine is busy

- **Status:** open
- **Claimed by:** agent-a (2026-08-05) — four of the five fixed; the box one is still open
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

## Four of the five were one clock, in the oracle (agent-a, 2026-08-05)

The diagnosis in this issue — "these five are the timing-sensitive shapes… a chunked-body reader that
presumably waits on a producer, two seeded fuzzers with a time or iteration budget" — turned out to be
right about the *class* and wrong about where to look. None of those four tests contains a deadline, and
neither do the fuzzers: `grep` for `Date.now`, `setTimeout`, `deadline` and `budget` across
`packages/http/test/` finds nothing in them.

The clock was one line down, in the oracle they all share:

```js
const CASE_TIMEOUT_MS = 60;   // packages/http/test/oracle_node.mjs
```

llhttp neither accepts nor rejects an incomplete message, so "the parser wants more bytes" was decided by
waiting 60 ms and seeing whether it had spoken. Under load a *complete* request misses that window, is
recorded as incomplete, and the differential fails with "llhttp wanted more bytes, wac accepted" — which
is why the failures were in http and why they named a parser disagreement that had not happened.

**The fix keeps the window and takes away its vote.** When it fires, the connection is half-closed and
llhttp is asked directly: a complete message reaches the request handler, a malformed one reaches
`clientError`, and one that genuinely needed more bytes reaches `clientError` with an EOF-state code or
aborts a request whose headers had already parsed. The answer comes from the parser and the end of the
input, so a slow machine costs milliseconds rather than a wrong outcome.

Removing the window *entirely* was the first attempt and it works, but `http.test.ts` went from 3s to
**40s**: some shapes leave node's server holding a half-closed socket until one of its own timeouts. The
window is what avoids that, which is why it stays as a hurry-up rather than a decision.

`packages/http/test/oracle_clock.test.ts` is the regression test, and it is the interesting part: it runs
the same cases with the window at 60 ms and at **zero** and requires identical outcomes, because a machine
too slow for the window to help is the same machine as one where the window is switched off. It also
checks that all three outcomes appear in the batch, so it cannot pass while exercising one path. Its first
version failed for a reason worth keeping: with the window at zero, a timer created before the connect
callback half-closed the socket *before the bytes went out*, which is an empty request rather than a slow
one. The nudge is armed after the write now.

Verified: `packages/http` passes three times in a row while a full suite runs beside it at five workers.

## The sixth is raised rather than removed

`did not report ready within 30000ms` was mine, from this morning. Two hundred milliseconds of work
against a thirty-second budget, and a busy machine still lost — because the budget competes with every
other process on the box rather than with the work. Two minutes now, on the same asymmetry as before:
waiting longer costs an already-broken bundle a few seconds, waiting less costs a working program a false
accusation in somebody else's run. `WAC_LOAD_GRACE_MS` still shortens it for the one test that has to sit
through it.

## What is left: the box test, which has no clock at all

`an endless producer stops at the cap rather than filling memory` (`packages/box/test/shell.test.ts:127`)
contains no wall-clock assertion, and neither does its `run` helper — a plain `Deno.Command` with no
deadline. I could not reproduce it: `packages/http` and `packages/box/test/shell.test.ts` pass at load
7.7, and with a full suite running beside them at five workers.

So it is a different mechanism and this issue should stay open for it. What I would try next, in order:
`yes | head -1` asserts `y\nstatus=0\n` exactly, so the failure is probably the missing `y` — which is
the shape 0078 had (a zero-length write ending a stream early) and which the same commit fixed. It may
already be gone. The second assertion in the test sends 50,000 lines through a pipeline and is the more
suspicious one under memory pressure. **A failure message would settle it**, and the report does not quote
one; whoever sees it next should paste the assertion text.
