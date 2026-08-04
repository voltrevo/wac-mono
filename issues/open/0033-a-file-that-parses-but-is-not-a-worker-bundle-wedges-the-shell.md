# 0033 — a file that parses but is not a worker bundle wedges the shell for ever

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-a
- **Date:** 2026-08-04
- **Kind:** bug
- **Symptom:** trap

0021 fixed the file that does not parse: it is now a failed command with a reason. The neighbouring
case is still a hang. A file that *is* valid JavaScript but never speaks the bridge protocol is
spawned, answers nothing, and `recv` waits for it for ever.

The most likely way to walk into it is the most likely mistake: putting a **built program** on
`$WACPATH` instead of a `--worker` bundle. Deno strips the shebang, the launcher evaluates, it spawns
a worker of its own and serves it — writing to the terminal it inherited — and the parent shell waits
on a handle that will never carry anything.

## Reproduction

```sh
deno task app:build packages/sh/src/sh.wac --allow-read --allow-write --allow-env -o /tmp/sh
mkdir -p /tmp/wp
deno task app:build packages/platform/example/wc.wac -o /tmp/wp/wc     # no --worker: a program
printf 'export const x = 1;\n' > /tmp/wp/silent                        # parses, says nothing

/tmp/sh -c 'WACPATH=/tmp/wp; wc; echo after=$?'       # hangs
/tmp/sh -c 'WACPATH=/tmp/wp; silent; echo after=$?'   # hangs
```

Both hung identically before 0021 was fixed, so this is not a regression from it — 0021's own notes
predicted it ("a bundle that parses but never speaks the bridge protocol does not kill the parent —
it hangs instead").

## Why it is not simply 0018

0018 — no timeout on a socket capability — is closed: `waitAny` takes a `millis` deadline now, so an
application *can* bound a wait. `packages/sh` does not use it: `trySpawn` calls `recv(handle).wait()`
with nothing bounding it. So the mechanism exists and the policy is missing.

The policy is the hard part, and is why this is filed rather than fixed:

- A deadline on `recv` would also cut off a **legitimate** child that computes for a long time before
  writing anything, which is a worse bug than the one being fixed.
- `entry.ts` now posts a `ready` message as soon as a worker bundle evaluates (that is how 0021
  distinguishes a load failure), so "no `ready` within a grace period" is a real discriminator for
  "this is not a wac worker". `children.ts` deliberately treats the grace expiring as *alive*, so an
  old bundle or a slow load is never reported as a program that would not start.
- Turning that grace into a failure would trade this hang for false "cannot execute" under load. On
  this machine — five cores, shared — module evaluation of a 500 KB bundle under load average 10 is
  not obviously under any grace period worth choosing. A timeout that changes the answer is the same
  mistake as 0031's, one layer down.

The honest options, in the order I would consider them: make `ready` a *required* part of the spawn
protocol and fail a child that does not send it (a version field would make that safe); or have
`sh` bound only the first `recv` and say "no response" rather than "cannot execute"; or leave it and
document that `$WACPATH` takes `--worker` bundles, which it already says and which nobody reads at
three in the morning.

## Notes

`spawn`'s docs and `sh`'s `trySpawn` comment both already say `$WACPATH` holds worker bundles. The
gap is that the failure mode for getting it wrong is a hang rather than a sentence.
