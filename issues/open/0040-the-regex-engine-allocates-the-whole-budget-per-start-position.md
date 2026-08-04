# 0040 — the regex engine allocates its whole budget of arrays per start position

- **Status:** open
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
