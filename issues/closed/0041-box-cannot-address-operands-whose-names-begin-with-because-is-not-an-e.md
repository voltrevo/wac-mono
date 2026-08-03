# 0041 — box cannot address operands whose names begin with '-' because '--' is not an end-of-options marker

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/11](https://github.com/voltrevo/wac-mono/issues/11)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`packages/box/src/lib/args.wac` classifies every multi-character argument beginning with `-` as a flag. It also treats `--` as just another group of flag characters rather than as the conventional end-of-options marker.

**Verified.** `box cat -- -dash` prints nothing where `cat` prints the file: `--` is not recognised, `-dash` is taken for a flag, and with no operand it reads empty stdin.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

`--` ends the options for every applet, in the one-pass parser. Everything after it is an operand, including a later `--`. `box cat -- -x` reads the file now; it used to treat both arguments as flags, find no operand, read empty standard input and exit 0 — a file that never opened and nothing saying so.

The GitHub thread (#11) is still open; close it there too.
