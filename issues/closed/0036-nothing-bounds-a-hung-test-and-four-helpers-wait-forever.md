# 0036 — nothing bounds a hung test, and four helpers are written to wait forever

- **Status:** closed 2026-08-05 by agent-b — all four helpers now have deadlines, via one
  shared `harness/deadline.ts`. The port race is split out as 0069.
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b
- **Date:** 2026-08-04
- **Kind:** bug
- **Symptom:** hang (observed once, not reproduced since; the missing deadlines are the confirmed part)

`deno task test` hung. Two tests sat at over eight minutes and **zero tests completed** before I
killed the run at about ten:

```
'gets: TLS 1.3 in wac, against a real TLS server' has been running for over (8m0s)
'waitAny parks until whichever socket speaks first' has been running for over (8m0s)
```

`packages/box/test/box.test.ts:1318` and `packages/platform/test/waitany.test.ts:43`.

This is the push gate. `tools/push.sh` runs `deno task test`, so an unbounded wait there is an
unbounded wait before anybody can push, with nothing to read but a warning that repeats.

## There is no timeout anywhere, and that is the actual defect

**Deno 2.9.1's `deno test` has no timeout option.** Not configured-and-too-long — absent. `deno test
--help` offers nothing, `deno.json` sets nothing. The `has been running for over (4m0s)` line is
informational and Deno will keep printing it for as long as the process lives. A blocked test is
therefore an infinite wait by default, for every test in this repo.

## Four helpers that block with no deadline

The hang is not a one-off; it is the shape of the readiness pattern used throughout. None of these
can fail — they can only not finish:

| helper | file |
|---|---|
| `waitForListening` | `packages/box/test/box.test.ts:805` |
| `serveOnce` | `packages/platform/test/waitany.test.ts:26` |
| `serveOnce` | `packages/tls/test/client.test.ts:32` |
| `serveOnce` | `packages/tls/test/handshake_interop.test.ts:31` |

`waitForListening` is the clearest:

```ts
while (!seen.includes(`listening on port ${port}`)) {
  const { value, done } = await reader.read();
  if (done) throw new Error(`the server exited before listening: ${seen}`);
  seen += dec.decode(value, { stream: true });
}
```

It handles the server *exiting* and not the server *living without printing*. If the child stays up
and never announces, `reader.read()` never settles.

## Why `--parallel` is likely the trigger

Ports come from bind-then-release — `freePort()`, and there are three copies of that too
(`packages/box/test/box.test.ts:789`, `packages/ssh/test/server.ts:17`,
`packages/ssh/test/server.test.ts:15`). Between releasing and the child binding, another test can
take the same port. `deno task test` passes `--parallel`, so test *files* run concurrently and that
window is real rather than theoretical. This is the same shape as **0026** (sshd's port-announcement
test is racy), which suggests one underlying pattern rather than three separate flakes.

**It did not reproduce, and that has to be said plainly.** After merging `origin/master` — which
brought agent-a's content-addressed build cache — the same `deno task test` ran in **50.3s, 967
passed, zero long-running warnings**. One attempt, so not a disproof, but the hang is not currently
reachable and the issue should not be read as a live fault.

So the standing of each claim is different, and worth separating:

- **Confirmed by reading the code, independent of any run:** Deno has no per-test timeout, and the
  four helpers below have no deadline. That is the defect, and it is what makes an unbounded wait
  *possible* whatever triggers it.
- **Observed once, not reproduced:** the actual hang, on a pre-merge tree, two tests past eight
  minutes with zero completing.

The likeliest mechanism for the difference is the build cache. Without it every test that builds a
binary rebuilds it, which lengthens the window in which bind-then-release can lose the port — so the
cache may have made a latent race much rarer without addressing it. It could equally have been a
leftover from my having killed a TLS test server earlier in the same session; I could not rule that
out either.

## Two different numbers both called "the suite"

Worth recording because it is how this keeps getting misdiagnosed. `deno task test` is
`deno test --parallel …`; a bare `deno test -A` is not parallel. I spent a session quoting ~3 minutes
for the second while 0031 quotes ~50s for the first, both of us calling it "the full suite".

**Two differences were confounded there, not one.** My 3-minute figures predate agent-a's build
cache, so the gap is `--parallel` *and* a cold rebuild every run, in unknown proportion. The honest
statement is only that the two commands are not the same measurement and the names do not
distinguish them.

## What to do

1. **Give every readiness wait a deadline** — the real fix. `AbortSignal.timeout` on the read, or
   `Promise.race` with a rejecting timer, so a stuck child fails the test in seconds with a message
   naming the port and what was seen so far. Four helpers, and they should probably become one in
   `harness/` rather than a fifth copy.
2. **Bind the port before handing it over**, or have the child accept a listener rather than a
   number, so bind-then-release stops being a race. This closes 0026 as well.
3. **Done, 2026-08-04: bound the gate.** `tools/push.sh` now wraps the run in
   `timeout --kill-after=30s 45m` and, on a timeout, says it is a hang rather than slowness and
   names the tests Deno reported as long-running. Exit status comes from `PIPESTATUS[0]`, so `tee`
   cannot mask it. 45 minutes is deliberately far above any honest run — the point is to convert
   infinite into finite, not to police performance, because a bound that fires on a busy machine is
   one people switch off. That is a backstop, not a fix; (1) is the fix.

## Notes

Not the same problem as 0031. 0031 is *contention* — a real fifty-second suite taking half an hour
because a mutation sweep had the machine. This is a *hang*, which no amount of idle CPU fixes. They
look identical from the outside, which is exactly why both need to be findable: the first time
somebody hits this they will read 0031, believe they are being starved, and wait.

## Resolution — 2026-08-05

`harness/deadline.ts`, with `withDeadline` and `readUntil`, and all four helpers converted:
`waitForListening` (box), and the `accept()` in the three `serveOnce`s (platform, tls ×2). Each now
fails in 30 seconds with a message naming what was awaited and quoting what the child printed, rather
than waiting for ever.

Thirty seconds rather than one, deliberately. A bound that fires on a loaded machine is one people
raise until it is useless, and this suite already competes with mutation sweeps (0031). The job was
converting *infinite* into *finite*, not policing latency.

`harness/deadline.test.ts` tests the helpers directly, including the exact case the old loop could
not distinguish from "not ready yet": a stream that stays open and says nothing — no chunk, no
`done`. It caught a real bug while being written. `withDeadline` originally took a `string`, so
`readUntil` composed its "so far it printed …" message *at the call*, before any reading had
happened, and every timeout said "it printed nothing" — true when the message was built, useless when
it was read. `what` is now a thunk.

**Item 2 is not done and is now 0069.** Ports still come from bind-then-release, so the window between
releasing and the child binding is still there; a child that loses the race is exactly the silent
non-starter these deadlines now catch. Catching it in 30 seconds with a clear message is a large
improvement over hanging, and it is not the same thing as closing the race.
