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

### A sixth mechanism, or the same one: the corpus test itself wedged for ten minutes (agent-a, 2026-08-05)

Not one of the five, and worth adding because the shape is the one this issue is about — a test that fails
or hangs for reasons outside the change under test.

`packages/sh/test/differential.test.ts`'s `every script agrees with bash` ran for **over ten minutes** and
was still going when I killed it, at load **0.55** on an otherwise idle machine. It normally takes 15–20
seconds. What I established before giving up on the diagnosis:

- **No script reproduces it.** All 614 literal cases run through the built binary in sequence, each with a
  6-second cap: none timed out.
- **Not the cases it was last logging.** Instrumenting the harness to print each script showed the last
  four started were `wc`-with-a-file cases; all four run in well under a second through the binary, and
  through `appRunner` — the in-process path the corpus actually uses — in 106 ms.
- **It went away.** Two runs immediately afterwards, same tree, 15 seconds each.

So it is intermittent, it is in the harness rather than in a script, and the likeliest place is the
eight-at-a-time `appRunner` concurrency in that test — which is where 0078's zero-length-write bug lived
too. A hang there is invisible in the way this issue describes: the suite reports nothing until Deno's
"has been running for over (4m0s)" warning, which names the test and not the case.

**What would make it diagnosable rather than mysterious**: the per-script `console.error` I added
temporarily should probably be permanent behind an environment variable. The harness knows which scripts
are in flight and prints none of them, so a wedge names the test and nothing else. That is the same
argument as `push.sh` printing its exit code, from 0077.

### The instrumentation is permanent now (agent-a, 2026-08-05)

The section above ends "the per-script `console.error` I added temporarily should probably be permanent
behind an environment variable". It is, and it does not need the variable to be useful:
`harness/inFlight.ts` is the four-at-a-time pool the corpus test now runs on, and it narrates itself.

- **On a wedge, unprompted.** If nothing completes for 45 seconds, the scripts still in flight go to
  standard error with how long each has been held, and again at every further 45 seconds. Nobody has to
  have predicted the hang, and it beats Deno's own four-minute warning, which names the test and none of
  its 614 cases.
- **`WAC_TRACE=1`** prints every start and finish, for when the order or the overlap is the question.

**This clock cannot fail a test**, which is the distinction this whole issue turns on: it only writes to
standard error. That is why its budget can be short enough to be useful without anyone tuning it against
another agent's load — the failure mode of the four clocks fixed above was that they *voted*.

`harness/inFlight.test.ts` provokes the case that matters rather than waiting for it: an item that never
resolves, a 300 ms budget, and an assertion that the stuck label appears on the child's real standard
error (a subprocess, because this Deno has no `dup2` and an injected sink would not prove the narration
reaches fd 2). It also pins the other half — work that is merely slow must say nothing — because a
narrator that cries in every loaded run is one that gets ignored.

**Today's attempt to reproduce the ten-minute wedge was self-inflicted and is not evidence.** I ran the
corpus under a pipeline whose `sed` had its own 30-second `timeout`, on a test that takes 32 seconds: the
reader died, the writer had nowhere to go, and the harness cut it off at ten minutes. Sent to a file
instead, the same tree passed in 37 seconds. So the wedge in the section above stands unreproduced — but
the next occurrence will name its scripts, which is the whole point.

**Still open for the box test**, unchanged: no clock in it, not reproducible here, and its assertion is
`assertEquals(r.out, "y\nstatus=0\n", r.err)`, which does print both the expected and actual text. Whoever
sees it next should paste that failure.

## Caught in the act: the narrator named it (agent-a, 2026-08-06)

The section above ends "the next occurrence will name its scripts". It did, twice in twenty minutes, and
the two are identical:

```
wac: scripts in flight for 55.0s with none finishing (677 of 681 done):
wac:   script held 55.0s: cd /tmp/8ff9133dce02f5d8/w25; printf 'a
wac:   script held 55.0s: cd /tmp/8ff9133dce02f5d8/w26; printf 'a
wac:   script held 55.0s: cd /tmp/8ff9133dce02f5d8/w27; seq 1 20000 > f; wc f
wac:   script held 55.0s: cd /tmp/8ff9133dce02f5d8/w28; seq 1 20000 > f; wc -l f
…
wac:   script held 550.1s: …the same four…
```

**What that establishes, which reasoning had not:**

- **It is the last four scripts, not four particular scripts.** 677 of 681 finished; the four that did not
  are the tail of the queue, one per worker. The pool is four wide, so *every* worker is stuck. Nothing
  else was running.
- **The shape matches the earlier hand-instrumented observation exactly** — `wc`-with-a-file cases — which
  I had recorded above and could not act on. Same four, same position, twice.
- **They are not slow, they are stopped.** 550 seconds against a 20-second whole-file run, with no
  progress in any of the twelve narration blocks.

**What it is not:**

- Not the scripts themselves. All four run in **188 ms** through the same `appRunner`, four at a time, in
  a fresh process. It needs the accumulated state of ~680 prior runs.
- Not load: the machine was otherwise idle, and the same file passed in 20 seconds between the two wedges.
- Not the six multi-line cases added at the same time. They pass in isolation, and this shape predates
  them — the note above records it from 2026-08-05.
- Not an obviously leaked worker: `spawnChild`'s `shutdown()` terminates the worker and stops the
  responder, and both are called on the child's result.

**Reproduction rate right now: two of three runs of `packages/sh/test/differential.test.ts`.** That is far
higher than it has been, which makes this the moment to chase it. The next step I would take is to
distinguish *which half* is blocked — each case awaits `bash(script)` and `wacsh(script)` together, so a
hung `Deno.Command` and a hung in-process worker are indistinguishable in the narration as it stands. A
label that changes as a case progresses would settle it in one run.

**The narrator is doing its job**: this went from "an intermittent hang I could not name" to "the tail of
the queue, every worker, reproducible" without anybody instrumenting anything by hand.
