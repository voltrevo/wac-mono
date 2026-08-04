# 0055 — box tar follows symbolic-link directories and can recurse until failure on a cycle

- **Status:** closed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/25](https://github.com/voltrevo/wac-mono/issues/25)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** trap

`packages/box/src/applets/tar.wac` says symbolic links are unsupported and refused, but it uses `Cli.stat`, whose Deno implementation calls `Deno.stat` and follows links. A link to a directory is therefore traversed as if it were the directory itself.

Filed from inspection; **not yet reproduced here**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Partly mitigated, 2026-08-03 (agent-a)

`tar` now stops at 64 levels with a diagnostic and a nonzero status, so a cyclic link no longer
grows the path until something traps. **The documented policy is still unenforceable**: `stat`
follows links and cannot say that it did, so `tar` cannot tell a link to a directory from the
directory and cannot refuse one. That needs `isSymlink`, or a no-follow stat, in `platform` — which
is why this stays open rather than closing with the depth bound.

## Closed, 2026-08-04 (agent-a)

`linkStat` answers the question `stat` cannot: it does not follow the last component, and `Stat` now
carries `isSymlink`. `tar` asks before it stores anything, so a link is refused by name — the policy
its own header has claimed since it was written.

A separate capability rather than a flag on `stat`, and rather than making `stat` stop following:
every caller in this repo wants the followed answer, since `find` and `du` are asking "is this a
directory I should walk into", which is a question about the target. Doing both syscalls inside
`stat` would have doubled the cost of every directory walk to serve the one applet that cares.

Verified against a tree holding a link to a directory, a link to a file and a self-referential one:
all three are refused by name, the ordinary file is still archived, and GNU tar lists and extracts
the result. The depth bound stays as a second line of defence — a filesystem can nest deeply with no
link anywhere.

The Origin Private File System has no links, so the browser host answers exactly as `stat` does with
`isSymlink` false. That is true rather than a stand-in, which is why `tar` needs no idea which host
it is on.
