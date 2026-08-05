# 0073 — a killed test run leaves its `sshd` behind, and thirty were running

- **Status:** closed
- **Reported by:** agent-a
- **Date:** 2026-08-05
- **Kind:** bug
- **Symptom:** wrong answer

## Reproduction

```sh
pgrep -af "sshd -D -f /tmp" | wc -l     # 32, on a machine where no ssh test was running
ps -o pid,ppid,etimes -p <any of them>  # ppid 1, and the oldest had been up two days
```

Start `deno test -A packages/ssh/test/transport.test.ts` and kill the run — `SIGKILL`, a timeout, the
container being stopped — and the `sshd` it started stays up for ever.

## Notes

`packages/ssh/test/server.ts` starts a real `sshd` as its oracle and both callers stop it in a
`finally`, which is right and is not enough: `finally` does not run when the process is killed, and a
`deno test` that outruns a timeout is killed. Every such run leaks one daemon, its port and its
`/tmp/<hex>` directory of host keys. Thirty had accumulated by 2026-08-05 (I killed them; two live
ones belonged to a run in progress and were left alone).

Nobody notices because the leak is invisible to the suite that causes it: the next run generates a new
key, asks `freePort` for a new port, and passes. What it costs is a shared machine — thirty listeners
and thirty temp dirs on a box that is already at 89% disk and regularly at load 14.

**An orphan is identifiable, which is what makes this fixable.** A test's `sshd` whose parent is init
cannot belong to a live test: the parent would be the `deno test` that started it. So `startServer`
can reap before it starts — for each `sshd -D -f /tmp/…` with `ppid == 1`, `SIGTERM` it and remove the
directory its `-f` names. That is a few lines in `server.ts`, it makes the suite self-healing on the
machine it runs on, and it cannot touch a running test's server.

Worth checking for the same shape elsewhere: `tools/push.sh`'s own timeout kills a suite mid-run, and
anything else that starts a real daemon as an oracle (`httpd`, the tor tests) has the same hole. The
built-binary leak had the same cause and was fixed with an `unload` handler, which covers a clean exit
and a throw but *not* a kill — so `unload` is not the answer here, reaping is.

## Closed, 2026-08-05 (agent-a)

`harness/reap.ts` kills the daemons a killed run left behind, and both ssh test files call it before
starting one: `server.ts` for the system `sshd` it uses as an oracle, `server.test.ts` for our own
`wacsshd`. The config directory goes with the process, since that is the other half of the leak.

**The safety property is the parent**, as this issue proposed: a process is killed only when its command
line matches a pattern the caller owns *and* its parent is init. A live test's server always has a live
parent, and so does another agent's, so neither can match. `harness/reap.test.ts` proves both directions
against real processes — an orphan made by a double fork, and a live child of the test that must survive.

**Three things were wrong before it worked, and each was invisible in the same direction.**

1. **`/proc` is not readable under the suite's permissions.** The first version read `/proc/<pid>/stat`
   directly; Deno answers `NotCapable: Requires all access to "/proc/…/stat"` unless the process has
   `--allow-all`, which the suite does not grant. The read threw, the catch returned an empty list, and the
   reaper reported success having looked at nothing. It goes through `ps -eo pid=,ppid=,args=` now, which
   needs `--allow-run` and gets the parent and the command line in one call. **This is the third guard in
   one day that this permission silently disabled** — see 0077, whose nesting check had the same hole.
2. **sshd rewrites its own argv.** `ps` shows a listener as
   `sshd: /usr/sbin/sshd -D -f /tmp/…/sshd_config [listener] 0 of 10-100 startups`, so a pattern anchored at
   the binary path matched nothing. `packages/ssh/test/server.test.ts` now asserts the pattern against that
   exact string, and against three things it must *not* match, including the machine's own
   `/etc/ssh/sshd_config` daemon.
3. **The test's own orphan-maker hung for two minutes.** `sh -c 'sleep 120 … &'` with a piped stdout waits
   for the *background* child's end of the pipe, so `outputSync` returned when the sleep did. Redirecting
   inside the shell fixed it. And `sleep 120 marker` is invalid — sleep refuses the second argument — so the
   marker rides in a shell's command line instead.

None of the three would have been caught by reading the code, and the first two were only caught because I
planted a real orphaned sshd and checked by hand whether it died. **A cleanup that cannot find anything is
indistinguishable from a clean machine**, which is why this needed an end-to-end check rather than a unit
test: planted orphan, run `transport.test.ts`, `ps` says the pid is gone and the config directory with it.

Not extended to the other daemons this issue mentions. `httpd` and the tor tests have the same shape, and
the mechanism is now one import away for whoever wants it — but a reaper whose pattern nobody has verified
against real output is worse than none, and I only verified these two.
