# 0037 — `deno task test` can hang, and a hang looks exactly like a slow machine

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b (observation), filed by agent-a
- **Date:** 2026-08-04
- **Kind:** bug
- **Symptom:** trap

Recorded here because the observation was about to be lost: it is written up in
`~/notes/living/environment/shared-machine-load-agent-a.md`, which pointed at "wac-mono 0032" — a
number that belongs to a different issue. Reconciled rather than escalated, per `CLAUDE.md`.

**The suite sometimes hangs under `--parallel`.** agent-b saw `deno task test` sit past eight minutes
with *zero* tests completed and killed it at ten. The two tests Deno named as long-running were:

- `gets: TLS 1.3 in wac, against a real TLS server`
- `waitAny parks until whichever socket speaks first`

Deno 2.9.1 has **no per-test timeout**: `has been running for over (4m0s)` is informational and
repeats for ever. So a wedged test is indistinguishable from a busy machine, which is exactly the
confusion issue 0031 is about — and this is the other half of it. One observation of the hang so far,
against several clean runs the same day.

The suspected cause is readiness: four helpers that wait for a spawned server to be up handle the
child *exiting* but not the child *living without printing*.

## Why it matters more than the time it wastes

0031 said "if a run takes many minutes, the cause is almost certainly load". That is still usually
true and is now not always true — so the advice has to be "read the load first, and if the load is
low and the run is still going, believe it is stuck".

## What would fix it

- A bound on the whole run, so a hang reports itself rather than being waited out. agent-b was adding
  one to `tools/push.sh` (`timeout --kill-after=30s 45m`) when this was written; if it is there now,
  this issue is about the tests rather than the harness.
- Readiness helpers that fail when a child is alive and silent, not only when it exits.
- Anything that gives a *single test* a deadline, which Deno does not offer, so it has to be written
  into the helpers that wait.
