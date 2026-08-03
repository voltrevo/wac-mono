# 0058 — regex '.' matches carriage return even though JavaScript dot does not

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/28](https://github.com/voltrevo/wac-mono/issues/28)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

The regex package states that its semantics are JavaScript's over an ASCII/byte-oriented subset, but `OP_ANY` excludes only line feed (`\n`). JavaScript's dot without the `s` flag excludes carriage return as well.

Filed from inspection; **reproduced here, then fixed**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

`.` excludes carriage return as well as newline. The oracle could not have caught it: its subject list had no `\r` in any of thirty strings, so the disagreement was unreachable by construction. Four carriage-return subjects are in it now, and reverting the fix fails three tests. U+2028 and U+2029 are still matched and cannot honestly be excluded by a byte engine — written down rather than pretended.

The GitHub thread (#28) is still open; close it there too.
