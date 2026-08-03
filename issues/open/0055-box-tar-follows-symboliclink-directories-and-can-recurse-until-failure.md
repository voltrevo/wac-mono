# 0055 — box tar follows symbolic-link directories and can recurse until failure on a cycle

- **Status:** open
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
