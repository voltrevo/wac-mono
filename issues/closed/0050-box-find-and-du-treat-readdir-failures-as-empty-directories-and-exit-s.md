# 0050 — box find and du treat readDir failures as empty directories and exit successfully

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/20](https://github.com/voltrevo/wac-mono/issues/20)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

When `Cli.readDir` fails it resolves to `null`, but both `box find` and `box du` silently treat that as an empty directory.

Filed from inspection; **reproduced here, then fixed**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

An unreadable directory is a failure in `find` and `du`, not an empty one: a diagnostic naming the directory and exit 1, with the partial total still printed, which is what GNU's `du` does.

The GitHub thread (#20) is still open; close it there too.
