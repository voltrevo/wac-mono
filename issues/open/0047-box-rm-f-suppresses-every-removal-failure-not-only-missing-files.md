# 0047 — box rm -f suppresses every removal failure, not only missing files

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/17](https://github.com/voltrevo/wac-mono/issues/17)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`packages/box/src/applets/rm.wac` treats any failed `remove` operation as success when `-f` is present. The force flag should suppress diagnostics for nonexistent operands, but it must not hide real failures such as trying to remove a directory without `-r` or lacking permission.

Filed from inspection; **not yet reproduced here**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.
