# 0050 — box find and du treat readDir failures as empty directories and exit successfully

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/20](https://github.com/voltrevo/wac-mono/issues/20)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

When `Cli.readDir` fails it resolves to `null`, but both `box find` and `box du` silently treat that as an empty directory.

Filed from inspection; **not yet reproduced here**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.
