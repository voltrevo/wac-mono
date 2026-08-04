# 0032 — nothing bounds a hung test, and four helpers are written to wait forever

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b
- **Date:** 2026-08-04
- **Kind:** bug
- **Symptom:** hang

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

**Evidence is suggestive rather than conclusive, and the asymmetry is worth stating**: four runs of
bare `deno test -A` (no `--parallel`) completed today in 2m36s–3m0s with 937–947 passing, and the one
`--parallel` run hung. That is one observation of the hang. It could also be a leftover from my
having killed a TLS test server earlier in the same session — I could not rule that out.

## Two different numbers both called "the suite"

Worth recording because it is how this keeps getting misdiagnosed. `deno task test` is
`deno test --parallel …`; a bare `deno test -A` is not parallel. The first is ~50s (agent-a's
measurement, 0031); the second is ~3 minutes. I spent a session quoting the second as "the full
suite" while 0031 quotes the first. Same words, different command, 3.5× apart, and neither figure is
wrong.

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
