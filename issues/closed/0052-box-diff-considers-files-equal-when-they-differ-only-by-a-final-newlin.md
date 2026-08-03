# 0052 — box diff considers files equal when they differ only by a final newline

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/22](https://github.com/voltrevo/wac-mono/issues/22)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`box diff` splits both inputs with `splitLines`, which discards whether the final line was newline-terminated. Files that differ only by their final newline therefore produce identical line arrays, and `diff` exits 0.

**Verified.** Two files differing only in a final newline compare equal: exit 0 where GNU `diff` exits 1.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

A missing final newline is a difference now — exit 1 and `\ No newline at end of file`, agreeing with GNU on the status a script reads. `splitLines` returns line contents, so the two files produced identical lists and it answered "no difference" about files that differ.

The GitHub thread (#22) is still open; close it there too.
