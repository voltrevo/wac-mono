# 0069 — tests hand out ports by binding one and releasing it, which is a race

- **Status:** closed
- **Claimed by:** agent-a (2026-08-05)
- **Reported by:** agent-b
- **Date:** 2026-08-05 (filed as 0067; renumbered same day — agent-a had already taken that number
  for the filesystem work, and theirs was pushed first)
- **Kind:** bug
- **Symptom:** flake

Split out of 0036, whose other half is done. Four copies of this:

```ts
function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const n = (l.addr as Deno.NetAddr).port;
  l.close();
  return n;
}
```

`packages/box/test/box.test.ts:1093`, `packages/ssh/test/server.ts:17`,
`packages/ssh/test/server.test.ts:15`, and the pattern again in `packages/platform/test`.

Between the `close()` and the child's `bind()`, anything else on the machine can take that port.
`deno task test` passes `--parallel`, so test *files* run concurrently and the window is real rather
than theoretical — and the ssh copy already documents it as "racy in principle; the window is
microseconds", which is the right diagnosis and the wrong conclusion, because there are three tests
opening that window at once.

## Why it is worth less than it was

0036 bounded the consequence. A child that loses the race now fails in 30 seconds naming the port and
quoting its output, instead of hanging the suite for ever. So this is a flake with a clear message
rather than an unbounded wait, which is a different order of problem.

## The fix, and why it is not one line

Hand the child a **listener** rather than a number, so there is no window: bind, pass the file
descriptor, never release. That needs the wac side to accept an inherited descriptor rather than a
port, which `packages/platform` does not currently offer — so this is a real feature, not a test
change, and it is the reason 0036 shipped the deadline first.

The cheaper alternative is to retry: on a bind failure the child exits, the test sees it, takes
another port and starts again. That closes nothing but makes the flake self-correcting, and it is
maybe ten lines in one shared helper next to `harness/deadline.ts`.

Either way the four copies should become one.

## Closed, 2026-08-05 (agent-a): hold the port until the bind

One allocator, `harness/port.ts`. Five copies, not four — the fifth was the same shape in
`packages/platform/test/node_net.test.ts`, and three more that *looked* like it are fine and were left
alone: `aliasing`, `listen` and `timeout` bind a listener and accept on it, so nothing can take it.

**The idea is to hold, not to guess.** `holdPort()` returns a port with its listener still open, and the
caller releases it immediately before the thing that binds:

```ts
const held = holdPort();
const args = [...whatever, String(held.port)];
held.release();                      // and now nothing else can get in first
const child = new Deno.Command(bin, { args }).spawn();
```

While it is held, no other process's probe can succeed — the kernel is the registry, and a held listener
is how you ask it. That makes a cross-process collision impossible for as long as the hold lasts, which
matters most in `packages/ssh/test/server.ts`, where two `ssh-keygen` runs and a config write happened
between the old allocation and sshd's bind. Hundreds of milliseconds of open window, now one `spawn`.

`withPort` wraps allocate-release-start and retries on `AddrInUse`, so the residual window costs a second
attempt rather than a red suite, and anything that is *not* a bind failure is rethrown immediately.

**Measured, at five workers — the count that used to fail:**

| | before | after |
|---|---|---|
| full suite at `DENO_JOBS=5` | 1 of 2 runs failed with `AddrInUse` (and the 0075 sweep's fifth run) | **3 of 3 passed, 0 `AddrInUse`**, 54–56s |

**A wrong turn worth recording.** The first version partitioned the ephemeral range by `Deno.pid % slices`
so that concurrent workers would draw from different slices. With a 1024-wide slice that is fifteen slices
for five workers, and two pids collide mod 15 more than half the time. Its own test caught it — at five
workers, by failing with exactly the error the whole change was about — which was luck in the sense that
the test happened to run under contention, and not luck in the sense that the test bound the ports it was
given. A test of an allocator has to use the allocator's contract; the first one probed and then bound in
a separate step, which is the very shape being fixed.

**The window is narrowed, not closed**, exactly as this issue said: that needs the child to inherit a
bound descriptor, which `packages/platform` does not offer. Nothing needs it now — the flake is gone at
five workers — so it is not filed as a feature; if a future test wants a truly zero-window server, this
paragraph is where to start.

**The worker cap stays at 4**, deliberately. 0075's ceiling was this bug, so five is now available, and
the measurement says it is not worth taking: 56s against 59s, on five cores shared with two other agents.
A 5% gain for every core on the machine is a bad trade, and the number in `tools/runTests.ts` should be
the one that leaves room rather than the one that wins a benchmark.
