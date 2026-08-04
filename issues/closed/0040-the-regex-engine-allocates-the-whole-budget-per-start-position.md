# 0040 — the regex engine allocates its whole budget of arrays per start position

- **Status:** closed
- **Claimed by:** agent-a
- **Reported by:** agent-a
- **Date:** 2026-08-04
- **Kind:** performance
- **Symptom:** wrong answer

`box grep 9` takes **7.3 milliseconds per line**. GNU `grep` takes 2 milliseconds for a two-thousand
line file; this takes 14.7 seconds for the same file, which is about 3,600× slower per line.

```sh
deno task app:build packages/box/src/box.wac --allow-read --allow-write -o box
seq 1 2000 > k.txt
time ./box grep 9 k.txt     # ~14.7s      (200 lines: ~2.1s)
time ./box grep -c 9 k.txt  # ~14.7s      — the same, so it is not the output
time grep 9 k.txt           # ~0.002s
```

## Where it goes

`runAt` in `packages/regex/src/program.wac`:

```wac
i32 cap = budget < 64 ? 64 : budget;
i32[] stackPc = i32[cap]();
i32[] stackSp = i32[cap]();
i32[] stackUndo = i32[cap]();
i32[] undoSlot = i32[cap]();
i32[] undoVal = i32[cap]();
```

Five arrays of `budget` elements, allocated on **every call**. `search` calls `runAt` once per start
position:

```wac
for (i32 start = at; start <= input.len(); start++) { … runAt(p, input, start, caps, budget); }
```

`grep` passes `budget = 1000000`, so each attempt allocates five million `i32`s — twenty megabytes —
and a seven-byte line makes eight attempts. That is 160 MB of allocation and zeroing per line, for a
pattern that is one literal character.

The comment above the allocation explains the sizing — "a program with `len` instructions cannot push
more than one frame per step, so the budget bounds the stack too" — and it is true. It is a bound, not
a size: the budget is a *limit* on work, and using it as the initial allocation makes the limit the
cost.

## What would fix it

- Start small and grow on push (doubling), keeping `budget` as the hard cap it was meant to be. A
  literal match never pushes at all.
- Or hoist the buffers out of `runAt` so one `search` allocates once rather than once per start
  position — worth doing anyway, and not sufficient alone: a long line is many start positions and one
  attempt still allocates 20 MB.
- A first-byte prefilter would cut most start positions for a literal-leading pattern, which is what
  makes real engines fast, but it is an optimisation on top rather than the fix.

`packages/regex/test/regex.test.ts` already fuzzes against JavaScript's `RegExp` and has a case for
the budget being exhausted, so the behaviour is pinned while this is changed.

## Notes

Found while measuring 0039 (buffered output): `grep` was the one applet whose time did not move,
because its time was never in the writes. The two are independent.

## Closed, 2026-08-04 (agent-a)

The five arrays start at 64 elements and double on demand, capped at the budget — which keeps the
budget the hard limit it was written to be, since a push that finds no room still answers `BUDGET`
exactly as it did when the arrays were that size from the start. `grown` is four lines. A literal
pattern never pushes at all, so it never allocates past the first 64.

Measured, same machine, same files:

| | before | after |
|---|---|---|
| `box grep 9` over 2,000 lines | 14.5 s | **0.098 s** |
| `box grep 9` over 20,000 lines | >120 s (killed) | **0.095 s** |
| `packages/regex`'s own test file | 17 s | **0.17 s** |

Both of the last two are process startup now. GNU grep does the 20,000-line file in 2 ms and still
wins by a mile — a first-byte prefilter is what closes that, and it is an optimisation rather than a
defect, so it is not done here.

The `OP_CLEAR` case needed the same treatment for a different reason: it appends one undo entry per
capture slot and checked room for all of them at once, which was right and was checked against the
*old* fixed size. It now grows to fit before appending.

The correctness net was already in place and is why this was a safe change to make: sixteen tests in
`packages/regex/test/regex.test.ts`, two of them fuzzing against JavaScript's own `RegExp`, plus the
case that pins a budget being exhausted rather than trapping. All pass, and the suite is 974 green.

**A side effect worth naming**: `regex.test.ts` was the second-heaviest file in the whole suite at
20 seconds, and is now a fifth of a second. The full run went from ~44 s to ~38 s on a quiet machine.
