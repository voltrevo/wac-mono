# 0028 — `sh` passes `GRANT_NONE` to `$WACPATH` programs, which is a decision nobody has made

- **Status:** closed (2026-08-04, agent-a)
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-a
- **Date:** 2026-08-03
- **Kind:** task
- **Symptom:** not implemented

`packages/sh`'s `trySpawn` runs an external program by reading it off `$WACPATH` and handing it
to `cli.spawn`. When `spawn` grew a grants argument I passed `GRANT_NONE`, because that is
exactly what the code was written against and a signature change is a bad moment to change
behaviour. It is in `exec.wac` with a comment saying as much.

But `GRANT_NONE` means **an external program is a filter and nothing else**: standard input,
standard output, no filesystem, no network. So

```sh
grep pattern file.txt        # if grep came from $WACPATH
```

cannot open `file.txt`. It is not broken — nothing in the suite fails — it is just narrower than
a shell usually is, and the narrowness is currently an accident of the order the two features
landed in rather than anybody's decision.

## The decision

Three defensible answers, and it is `sh`'s owner's call:

1. **Keep `GRANT_NONE`.** External programs are filters; document it in the README next to
   `$WACPATH`, and a script that wants a file redirects into one. Defensible, and the safest.
2. **Pass what the shell itself has.** `GRANT_READ | GRANT_WRITE | GRANT_NET | GRANT_ENV`, so a
   spawned `grep` behaves like a real one. The host intersects with the shell's own grants, so
   this cannot exceed what the user gave the shell — it is "children are as trusted as I am".
3. **Ask the script.** A variable — `WACGRANTS=read,net` — so a script says what it is willing
   to hand over. More rope, and the only option that lets one script be careful and another not.
   Also the only one that needs syntax nobody has asked for yet.

I would take (2) with (1) documented as the reason if it is rejected: a shell's children
inheriting the shell's authority is what every other shell does, and the interesting property
was never that children get *nothing* — it is that they cannot get *more*, which the host
enforces either way.

Filed rather than decided because `packages/sh` is not mine, and because "what may a spawned
program do" is exactly the kind of thing that should be somebody's decision rather than a
side-effect of my commit. `packages/platform/README.md` has the grant table if it helps.

## Closed, 2026-08-04 (agent-a) — answer (2)

The operator's answer was **inherit the shell's grants**, which is option (2) above and the one every
other shell implements. `trySpawn` now passes `GRANT_READ | GRANT_WRITE | GRANT_NET | GRANT_ENV`, the
same set `trySelf` already handed an applet of the shell's own bundle — so the two routes to a real
program agree about authority instead of differing by an accident of which was written first.

The host intersects with what the shell itself holds, so this cannot widen anything: a shell built
with no grants still hands its children none. Both halves are tested in `sh/test/spawn.test.ts` —
`wc file` through `$WACPATH` now answers what the same program answers run alone, and the same script
through a shell built without `read` still cannot see the file. The first fails on the old code with
"filesystem read not granted to this application", which is the bug in one line.

What made it a decision rather than a fix was that it widens what a script can reach; what made it an
easy decision is the intersection. Filed as a task, closed as a task: nothing about the implementation
was interesting once somebody had said which of the three it should be.
