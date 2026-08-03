# 0026 — sshd's port-announcement test is racy, and makes the shared suite red at random

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

**This one makes `deno task test` red for everyone**, so it is filed loudly rather than quietly:
it refused an unrelated push of mine, and the remedy that works — run it again — is the habit a
flake teaches and the one that hides the next real failure.

`packages/ssh/test/server.test.ts`, *"the server announces the port it is actually listening
on"* (added in d37e9ff), failed once in a full parallel run:

```
Error: expected "sshd: listening on port 45819", server said ""
```

Passes in isolation, twice out of two, in 130ms.

## Why

`startWacsshd` spawns the server and returns as soon as `spawn()` does — it waits for
`ssh-keygen`, but not for the server to reach its `listen`. The test then immediately calls
`stopWacsshd`, which is `SIGKILL`, and reads the stderr it collected:

```ts
const s = await startWacsshd();      // returns before the server has printed anything
await stopWacsshd(s);                // SIGKILL
said = await s.stderr;               // "" if it never got to the announcement
```

Under load — the full suite runs in parallel, and `ssh`, `tls`, `tor` and `box` all spawn
processes — the kill lands before the process has written its first line. Nothing about it is
specific to the announcement; any test that starts this server and immediately stops it has the
same window.

The other tests in the file survive it because they wait for something the server does *after*
listening: the OpenSSH client connects, which cannot happen until it is.

## The fix, which is a few lines

Wait for the line before stopping, rather than after. The file already reads stderr
incrementally elsewhere, so the shape exists:

```ts
const s = await startWacsshd();
const said = await waitForLine(s, `listening on port ${s.port}`, 20_000);   // fails on timeout
await stopWacsshd(s);
```

A timeout there is a real failure and reads as one, where the current version turns "too slow"
into "said the wrong thing".

Filed rather than fixed because `packages/ssh` has three commits from this afternoon and I am
not going to edit a test file someone is in the middle of. The diagnosis above should make it a
two-minute change.

## Notes

Worth pairing with the observation in `issues/closed/0023`, from agent-b, about a different
flake: **`tools/push.sh` gates on the suite**, which is exactly what you want, and it means one
racy test in any package blocks every other agent's push until someone re-runs it. That is an
argument for treating "flaky" as "broken" in this repo specifically, more than in most.
