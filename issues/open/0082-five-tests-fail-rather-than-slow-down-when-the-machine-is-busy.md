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

## It is ours, not bash — and the next wedge will say which await (agent-a, 2026-08-06)

The previous section asked for a label that distinguishes the two halves of a case. It exists, and it
answered on the first wedge after it landed:

```
wac: scripts in flight for 184.9s with none finishing (676 of 680 done):
wac:   script held 185.0s [wacsh]: … printf 'a
wac:   script held 185.0s [wacsh]: … printf 'a
wac:   script held 185.0s [wacsh]: … seq 1 20000 > f; wc f
wac:   script held 184.9s [wacsh]: … seq 1 20000 > f; wc -l f
```

**Every stuck case is waiting on `wacsh`.** The real `bash` returned in all four; our own shell, run
in-process through `harness/appRun.ts`, never did. That removes `Deno.Command`, the subprocess pipes and
bash itself from the search, which is most of the surface.

**And the phase is instrumented now.** `RunOptions.note` reports `loading`, `running` and `draining`, so
the next wedge says `[wacsh:running]` or `[wacsh:draining]` — three different bugs:

- *loading* — the child never reports ready. Unlikely: that path has a 120-second grace and then reports
  `did not load`, which is an error rather than a hang, and these hang past 180 seconds in silence.
- *running* — the child never finishes `main`. That points at the bridge or at a host handler that never
  settles.
- *draining* — the child finished and its output queues were never ended, so `out.rest()` waits for a
  sentinel that is not coming. `shutdown()` is what ends them.

**The bridge protocol itself reads correct**, for what that is worth: both sides use the seen-value
pattern — the worker loads `DONE_SEQ`, checks the slot, then `Atomics.wait`s on the value it read, and the
host loads `SUBMIT_SEQ` before its sweep and `waitAsync`es on that. A wakeup arriving in between makes the
wait return immediately rather than sleeping through it. So a plain lost notify is not the explanation, and
the evidence should come from the phase rather than from more reading.

**A correlation worth knowing before the next hunt: it wedges on an idle machine.** Three wedges, all at
load below 1. Twelve consecutive runs at load 3–6 — another agent working — were clean, 20-40 seconds
each. That is the opposite of what a "too busy" theory predicts, and it fits a race whose window opens when
everything is fast: the first run of a loop on a cold machine is the one that hangs.

### A seventh member of the class, seen in a gate run (agent-a, 2026-08-06)

```
run a command on a real OpenSSH server and read its output => packages/ssh/test/transport.test.ts:1023
error: ConnectionReset: Connection reset by peer (os error 104)
    at async read (packages/ssh/test/transport.test.ts:135:15)
    at async handshake (packages/ssh/test/transport.test.ts:156:40)
```

**It failed in 25 ms**, so this is not a deadline firing — it is sshd hanging up during the handshake.
The same file passes alone in one second, 35 tests, immediately afterwards. The run that failed was the
whole suite at five workers with another agent's work merged in.

Two candidates, neither confirmed, both cheap to test when somebody is in that file:

- **`MaxStartups`.** The fixture's generated `sshd_config` does not set it, so sshd uses its default
  `10:30:100` and starts refusing unauthenticated connections at random once ten are in flight. Each test
  starts its own sshd, so this needs several of them to be starting at the same moment — which is exactly
  what `--parallel` does. `server.ts`'s own header already quotes the `0 of 10-100 startups` in sshd's
  process title, so the number is right there.
- **A dying server on a reused port.** `harness/port.ts` holds the listener until just before the bind,
  which closes the window for two *starting* servers, not for one that is still shutting down while the
  next test connects. A connection that reaches a closing sshd is reset rather than refused, which is
  what this looks like.

Recorded rather than guessed at: a fix in somebody else's fixture that is not backed by a reproduction is
noise, and this issue is about failures whose cause is not where the failure is.

### The phase: `running`. The child never finishes `main` (agent-a, 2026-08-06)

```
wac:   script held 100.4s [wacsh:running]: cd /tmp/…/w27; seq 1 20000 > f; wc f
wac:   script held 100.4s [wacsh:running]: cd /tmp/…/w28; seq 1 20000 > f; wc -l f
```

So of the three candidates named above it is the middle one, and the other two are out:

- **not `loading`** — the child reported ready, so the bundle evaluated and the bridge arrived;
- **not `draining`** — `child.exit` never resolves, so the drain is never reached. Whatever is wrong is
  upstream of the output queues, which removes `ByteQueue`, `endWith` and the shutdown path.

`exit` settles from exactly two places, both in `spawnChild`: the worker's result message, and its error
handler. Neither fired in 100+ seconds, so the worker is alive and inside `main`.

**The next question is what it is waiting for, and the answer is instrumented now.** `harness/appRun.ts`
prints the bridge's slot table every 45 seconds while a child is running:

```
wac: packages/sh/src/sh.wac still running: 0:claimed:RECV 1:pending:RECV 2:pending:RECV 3:pending:RECV
     (submit=474 done=940)
```

That distinguishes the two remaining shapes without another wedge to interpret:

- **slots pending** — the worker submitted a host call that was never answered. The responder loop, or a
  handler that never settles.
- **no slot in use** — the worker is not in a host call at all, and the stall is inside wac: a loop that
  does not terminate under some interleaving, or a `parkForHost` that nothing will ever wake because there
  is nothing outstanding.

Provoked deliberately to check it fires (`WAC_STALL_MS=300` against `seq 1 3000000 | wc -l`), because a
narrator nobody has seen fire is one nobody knows is broken.

### The slot table, and a label that had me reading it backwards (agent-a, 2026-08-06)

The dump fired on the next wedge, and said this — four children, all the same:

```
wac: packages/sh/src/sh.wac still running: 0:pending:RECV 1:pending:RECV (submit=23 done=42)
```

**Then I found the labels were wrong.** `describeSlots` indexed its name table by declaration order, and
the constants are not declared in value order: `ST_CLAIMED` is 5, not 1. So what it printed as `pending`
was `ST_RUNNING`. That inverts the diagnosis completely —

- `pending` would mean *the host never took the slot*: a responder that stopped, or a lost wakeup.
- `running` means *the host took it and the handler never came back*: a wait inside a capability.

An hour of the reading above was spent on the first. The table is keyed by value now, and the comment
says why, because this is the second time a diagnostic in this repo has been confidently wrong.

**With that fixed, the dump names the wait.** A healthy pipeline looks like:

```
still running: 0:running:RECV(h=1) 1:running:RECV(h=2) 2:running:RECV(h=3) 3:running:RECV(h=4)
               (submit=386 done=764) host: running=true sweeps=386
```

The handle is in it now, because `RECV(h=0)` is standard input and `RECV(h=N)` is *a spawned child's
output* — different waits with different causes, and the opcode alone cannot tell them apart. The
responder's own liveness is in it too: `sweeps` that stops moving says the loop is parked, `running=false`
says it is gone.

**So the shape to expect at the next wedge** is a shell blocked in `RECV` on a child it spawned, whose
output queue never ends — which moves the question one level down, to what that grandchild is waiting for.
`packages/sh` spawns its applets when it can, so `wc f` really is two programs.

**And a fix that stands on its own, whatever the cause turns out to be:** a responder whose loop throws
used to leave every pending slot pending for ever, because `loop()`'s promise is not awaited by most
callers — the worker then waits in `Atomics.wait` for an answer that can no longer come, which is a silent
hang exactly like this one. The loop now catches, says `the host responder stopped: …` on standard error,
and fails every outstanding slot so the worker unparks with an error it can report. That is worth having
even though it is not yet known to be this bug.

### The load correlation is now the strongest signal (agent-a, 2026-08-06)

Counting every run made while chasing this:

| machine | runs | wedges |
| --- | ---: | ---: |
| load below 1 (idle) | 4 | **4** |
| load 2–6 (another agent working) | 22 | 0 |

Every wedge has been on an idle machine, and twenty-two consecutive runs under ordinary load were clean —
twenty of them *after* the instrumentation landed, which is why the corrected slot dump has not yet been
read at a wedge. That is the opposite of what the issue's title says about this class, and it is the most
useful thing known about this particular one: **to reproduce it, wait for the machine to be quiet.**

It also says something about the shape. A race that needs two events close together is likelier when
everything is fast and nothing is descheduled; spreading the interleavings out with load hides it. The
candidate that fits is the shell's `RECV` on a spawned applet's output racing that applet's `end()` — a
`next()` registered at the moment the queue ends, or an `end()` that lands between a `take` and a park.

The next occurrence will print `RECV(h=N)`, the responder's sweep count and whether it is still running,
which distinguishes those without another round of guessing. The hunt is a loop of the corpus with a ten
second settle between runs; on a quiet machine it has hit on the first run three times out of four.

### The symptom is fixed even though the cause is not (agent-a, 2026-08-06)

Reproduction stayed out of reach this tick — the machine had another agent on it, and ten runs at load
3–9 were clean — so the work went to the part that does not need a reproduction: **a wedge no longer
hangs.**

`harness/appRun.ts` now concludes *deadlock* from the bridge's own state rather than from elapsed time.
Every 45 seconds it compares the slot table and the counters with what they were last time; if they are
identical twice running **and** a call is outstanding, it fails the run with the state in the message:

```
packages/sh/src/sh.wac is deadlocked: the bridge has not moved in 90s with work outstanding —
0:running:READ_STDIN (submit=7 done=12) host: running=true sweeps=8. This is wac-mono 0082 …
```

**Why this is allowed to decide when the rest of this issue argues that clocks must not.** It is not
deciding on duration: a slow machine still moves — `sweeps` climbs, `done` climbs, slots change hands — so
a frozen table with work outstanding is a *state*, and the duration only says how long to look before
believing it. `no slot in use` is explicitly not a deadlock, so a program that computes for a long time
with nothing outstanding is never failed.

`harness/deadlock.test.ts` is both halves of that claim, and builds the wedge rather than waiting for one:
`endStdin: false` leaves a `read` waiting for bytes and an end that will never come, which is the same
frozen shape, and it is detected in two seconds at a 700 ms budget. The second test runs
`seq 1 300000 | wc -l` at a 500 ms budget and must *not* be failed — if that one ever fails, the detector
has started looking at time instead of progress and every long-running program is about to be reported as
broken.

What this buys, until the cause is found: a wedge costs one failing test with the wait named, instead of
the push gate's 45-minute timeout spent on no information at all.

### The three that still flake say so in their names (operator's call, 2026-08-06)

> "I think we should tag these tests as flaky in the test name and link the issue. That way when they fail
> the flake is a clear alternative explanation. Obviously we should just not be flaky in the first place,
> but until that's solved it should at least be clear to avoid chasing the wrong geese."

Done, for the three that are still open members of this class:

| test | file |
| --- | --- |
| `[flaky 0082] every script agrees with bash on output and exit status` | `packages/sh/test/differential.test.ts` |
| `[flaky 0082] run a command on a real OpenSSH server and read its output` | `packages/ssh/test/transport.test.ts` |
| `[flaky 0082] an endless producer stops at the cap rather than filling memory` | `packages/box/test/shell.test.ts` |

In the *name*, so the explanation arrives in the line the runner prints, at the moment somebody is deciding
whether they broke something. A tracker entry only helps a reader who already suspects the suite, which is
the state this issue's reporter reached after an hour.

**Deliberately not tagged: the four that were fixed.** Tagging a test that is no longer flaky is how a real
regression gets waved through, and it is the failure mode of this whole practice.

`tools/flaky.test.ts` is what keeps it from becoming one:

- every `[flaky NNNN]` must name an issue in `issues/open/`. **When this issue is closed and the tags are
  not, the suite fails and names the lines to edit** — so the tag and the issue come off together.
- the issue it names has to read as one about intermittent failure, or the tag is a dead end for whoever
  follows it mid-diagnosis;
- the convention is required to be written down in `issues/README.md`, so the next person does not invent
  a different spelling;
- and every green run prints the list, because three flaky tests became normal here by nobody counting
  them out loud.

Verified it fails: pointing one tag at a closed issue reports
`packages/box/test/shell.test.ts:130 is tagged [flaky 0011], which is closed`.

### The ssh member is fixed at its root: a lane rather than a fifth workaround (agent-a, 2026-08-06)

`ConnectionReset` during an OpenSSH handshake, under five parallel workers, once in eight suite runs. The
next thing I was about to try was setting `MaxStartups` in the fixture — which would have been the *fifth*
workaround for one decision. The others: `harness/port.ts` holding a listener until the bind,
`harness/reap.ts` killing sshds orphaned by a killed run, that reaper's pattern being deliberately
unanchored because sshd rewrites its argv, and a two-minute worker-readiness grace.

The decision was running tests that need exclusive machine resources concurrently with everything else. So
a file can now declare that it needs the machine:

    // test-lane: exclusive — a real OpenSSH server per case, on a real port

and both `deno task test` and `deno task test:changed` run those files in a pass of their own, one at a
time, after the parallel pass. Three files declare it, all in `packages/ssh`.

**Measured cost: about 10 seconds** on a 70-second suite — 1183 tests in parallel, then 46 alone. That buys
the removal of a flake whose cause was never established, and it would have removed it whichever of the two
candidates was right, because both are consequences of concurrency rather than of ssh.

Kept honest by `tools/lane.test.ts`: every declaration must give a reason, the lane's membership is printed
on every green run, and more than six files in it fails the suite — because "run it alone" is an easier
answer than fixing a test, and a lane with twenty files in it is a sequential suite wearing a lane.

`harness/testLane.ts` holds the one decision, `laneSplit`, and it is unit-tested because both callers got
it wrong when it was written inline: `test:changed` compared a *directory* target against a *file* path so
nothing ever matched, and its whole-suite mode passes no targets at all, where "no targets" means
everything rather than nothing. Neither mistake failed anything — the suite passed, in parallel, exactly as
before, and said nothing either way.

**The tag stays on the ssh test for now.** One clean gate run is not evidence that a once-in-eight flake is
gone; a week of them is. `tools/flaky.test.ts` will make somebody take it off when 0082 closes.

### A mechanism, found by enumeration rather than by waiting (agent-a, 2026-08-06)

The operator's question was whether buffers and backpressure can be made deterministic. They can — not by
removing the nondeterminism, which `waitAny` genuinely needs, but by separating the *semantics* from the
*scheduling* so every interleaving can be walked instead of sampled. Two state machines came out of that,
and the second one found a live hole in about a minute.

**The queue** (`host/queue.ts`) is now `apply(state, event) → (state, effects)`, pure, with `ByteQueue` as
a driver that holds no rules. `test/queue_model.test.ts` walks every sequence of pushes, reads, ends and
cap-driven parks to depth six — 117,649 paths — against the invariants that matter: a reader told the
stream ended when it had not; a reader parked with bytes queued; the first parked writer having room;
bytes lost, duplicated or reordered after their writer was told `ok`. Two of its four tests are mutants,
because an invariant set that passes a known bug is decoration: re-introducing **0078** makes it fail and
print the counter-example, `push(1b) → push(1b) → next(≤64) → next(≤1) → push(0b)`.

The queue passing everything is what made the next step obvious: **a stream that never ends is not a queue
bug, it is `end()` never being called.** So the child's lifecycle got the same treatment
(`host/childLife.ts`), over the four things the runtime can deliver in any order — ready, result, error,
grace — plus the caller's kill.

**It reported a violation at depth one.** `kill` on a child that has not yet reported ready left both
`loaded` and `exit` unsettled. In the real `spawnChild`, `kill` *was* `shutdown`: it ended the streams and
stopped the responder, and settled neither promise. So:

- `OP.EXIT_CODE` is `await child.exit`;
- a handle closed anywhere else — `CLOSE` on a child calls `kid.kill()` — leaves that promise unsettled;
- the worker is then parked in `Atomics.wait` on a call that can never be answered.

**That is the observed wedge state exactly**: a slot stuck in `running`, the host alive with its sweep
count frozen, and everything else finished. `packages/sh` happens to guard its own path — it skips
`exitCode` for a stage it stopped, and says so in a comment — which is consistent with the wedge being
rare and appearing at the tail of a run rather than every time.

**Fixed**: `kill` now settles `loaded` with why, ends the streams, and settles `exit` with -1, in that
order. Promises make each idempotent, so a child killed after it finished keeps the code it returned.

**Not yet claimed as *the* cause**, because I have not reproduced the corpus wedge with the fix in and
watched it not happen; a once-in-fifty hang needs more than one clean run. What can be said is that this
mechanism produces exactly the state that was observed, it is now impossible, and the deadlock detector
would turn any survivor into a named failure in ninety seconds rather than a hang.

### The third layer: the bridge protocol is sound, which eliminates it (agent-a, 2026-08-06)

`test/bridge_model.test.ts` walks every interleaving of the two agents' moves over one slot — claim,
publish, take, answer, collect, cancel, reclaim — to depth nine, against: an answer collected that belongs
to a different call; a slot freed while the host is inside its handler; a slot published with no opcode; and
a slot **owned by nobody**, meaning nothing will ever move it again.

**No violation.** Seven distinct slot states are reachable and every one of them can return to free. So the
protocol is not where the wedge is, which agrees with the observed evidence — the slot was `running` with
the host alive, meaning it *had* been taken and the handler never came back — and leaves the lifecycle hole
fixed above as the mechanism that matches.

Both historical bugs are caught by the same invariants, which is what makes the "no violation" worth
anything:

- the plain store where a compare-and-exchange belongs, by
  `claim → publish → take → cancel → take → answer` — the exact race the code's own comment describes;
- one state for "claimed" and "pending" together, by a slot published with no opcode in it, which is the
  `no handler for capability 0` this repo saw.

Ownership had to be stated precisely for the first of those to be caught at all: a slot is owned if it is
free, claimed, cancelled, held by a live ticket, or being worked on. Writing it as "ready counts as owned"
let the mutant through, because that bug's whole signature is an answer written into a slot whose ticket
had already died.
