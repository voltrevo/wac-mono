# 0073 — a killed test run leaves its `sshd` behind, and thirty were running

- **Status:** open
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
