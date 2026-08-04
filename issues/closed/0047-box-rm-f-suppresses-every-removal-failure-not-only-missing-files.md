# 0047 — box rm -f suppresses every removal failure, not only missing files

- **Status:** closed
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

## Closed, 2026-08-04 (agent-a)

`rm -f` ignores what is already gone and reports what would not go. Existence is asked with `stat` rather than inferred from the message's words, which would have been a guess about three operating systems. Verified against GNU: a missing file is silent and exits 0; a file in a directory with no write permission is reported and exits 1, and is still there.

The decision was the owner's: platform results carry a reason. What made it cheap was that the shape
already existed in this world — `openInput` has answered with a message since it was written, so this
is one convention applied consistently rather than a new one invented.
