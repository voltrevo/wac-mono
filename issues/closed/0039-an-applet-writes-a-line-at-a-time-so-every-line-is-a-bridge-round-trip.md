# 0039 — an applet writes a line at a time, so every line is a bridge round trip

- **Status:** closed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-a
- **Date:** 2026-08-04
- **Kind:** performance
- **Symptom:** wrong answer

`box seq 1 200000` takes **14.5 seconds**. GNU `seq 1 200000` takes 2 milliseconds. The work is not
the arithmetic: it is two hundred thousand calls to `cli.write`, one per line, each of which parks the
worker on `Atomics.wait` while the host answers.

```sh
deno task app:build packages/box/src/bin/sh.wac --allow-read --allow-write --allow-env -o wacsh
time ./wacsh seq 1 200000 > /dev/null          # ~14.5s
time seq 1 200000 > /dev/null                  # ~0.002s
```

Measured with no pipeline and no shell in the way: `./wacsh -c 'seq 1 200000' > /dev/null` costs the
same 16 seconds, and `seq 1 200000 | wc -l` costs 16.5 — so the pipeline is ~2 seconds of it and the
writes are the rest.

## Why it matters more now

It used to be hidden. An applet called *in process* by the shell wrote into a buffer in the same wasm
instance — a function call. Now that a shell runs its applets as spawned children (issue 0030), those
writes cross the bridge, and the cost is a park and a wake per line. Streaming pipelines made
`seq 1 200000 | head -1` eighty times faster and left this in plain view.

Every real program buffers for exactly this reason: a `write` syscall per line is why `stdio` exists.

## What would fix it

Buffer inside the applet and flush in blocks — 64 KiB is the natural size, since `CHUNK` is what a
read answers with and the bridge copies through a ring of that order.

- `packages/box/src/lib/` is where a shared writer belongs, beside `input.wac`'s reader.
- The applets that emit many small pieces are the ones to convert: `seq`, `yes`, `nl`, `cat` of a
  line-oriented file, `sort`'s output, `uniq`, `tac`, `shuf`, `paste`, `strings`.
- The flush has to happen before the applet returns *and* before anything that reads — a buffered
  writer that forgets to flush is a program that prints nothing, which is a worse bug than a slow one.
- `write` answering false still has to end the program: `yes` is `while (cli.write(block)) {}`, so a
  buffered writer must pass the refusal on rather than swallowing it.

## Notes

Not a platform issue. The bridge's per-call cost is what it is — a park and a wake — and a program
that makes two hundred thousand of them is asking for it. `gzip` and `sha256` already write in blocks
and are fast, which is the shape to copy.

## Closed, 2026-08-04 (agent-a)

`lib/out.wac` holds a `Sink`: a `Buf` and a `Cli`, flushed at 64 KiB — `CHUNK`, the size the bridge
moves. Every method answers "keep going", because `write` answering false is how `box yes` learns to
stop and a buffer that swallowed it would be a producer filling memory for a reader that has left.

Measured on this machine:

| | before | after |
|---|---|---|
| `box seq 1 200000` | 14.5 s | **0.148 s** |
| `seq 1 200000 \| wc -l` | 16.5 s | **0.19 s** |
| `box nl` / `rev` / `uniq` over 20,000 lines | seconds | ~85 ms, which is process startup |

Converted: `seq` (`core.log` per line), `grep` (a line per match), and the seven that went through
`reader.wac`'s `emit` — `nl`, `head`, `tail`, `cut`, `fold`, `rev`, `uniq` — plus `strings`, which has
its own `emit` over a `Buf` and now writes through a sink. `emitTo` is the buffered twin of `emit`,
which stays for the places that write once and return.

`tac`, `sort`, `shuf` and `paste` already wrote once, through `joinLines`; `yes` already wrote 4,096
lines per call and says why in its header. Those were the shape to copy.

**Every path out has to flush**, since there are no destructors. What keeps that honest is
`test/box.test.ts` comparing against the real tool byte for byte: a missing flush is an empty answer
where GNU has output, and it fails rather than drifting. All 29 of those tests pass, and the suite is
974 green.

## What this uncovered, and is *not* fixed here

`box grep 9` costs **7.3 ms per line** — 2.1 s for 200 lines, 14.7 s for 2,000, and GNU takes 2 ms for
the same file. `-c` costs the same, so it is not the output: it is `search`, and the cause is visible
in `regex/src/program.wac`. `runAt` allocates five `i32` arrays of `budget` elements *per start
position*, and `grep` passes a budget of a million — twenty megabytes of arrays per attempt, eight
attempts for a seven-byte line. Filed as 0040.
