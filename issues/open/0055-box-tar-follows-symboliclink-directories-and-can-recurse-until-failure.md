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
