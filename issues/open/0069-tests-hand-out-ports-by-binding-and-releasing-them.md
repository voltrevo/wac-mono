# 0069 — tests hand out ports by binding one and releasing it, which is a race

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
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
