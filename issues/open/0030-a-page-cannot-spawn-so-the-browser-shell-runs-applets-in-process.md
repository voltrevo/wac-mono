# 0030 — a page cannot `spawn`, so the browser shell runs applets in-process instead

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-a
- **Date:** 2026-08-03
- **Kind:** missing feature
- **Symptom:** not implemented

`spawn` is implemented in the Deno host and in the Node host, and not in the browser host. So a
program in a page cannot run another program, and `packages/sh`'s `trySpawn` always misses there.

That gap is why `pushChild`/`popChild` exist: with them, `packages/box`'s sixty applets run
*inside* the shell's own wasm instance, which is what makes `sort`, `sha256sum` and `gzip` commands
you can type in the browser terminal. It works, and the shell prefers a real spawned program when
there is one, so this is a fallback rather than a replacement.

What it is not is a boundary. An applet running in-process has the whole program's authority: it
can open any file the shell could, and a grants argument would be a decoration. `spawn` is the
thing with an answer to that — a separate worker, its own grants, intersected with the parent's.

## What the browser is actually missing

Nothing about a browser forbids this. A worker can create a worker, and the pieces are already
here:

- Each program needs its own `SharedArrayBuffer` and a responder answering its calls. The
  responder runs on the page's own thread today, and the page can host a second one for the child
  as easily as the first.
- The child's stdio is already expressible: `ByteQueue` and the `readIn`/`writeOut` hooks in
  `host/children.ts` are what the Deno host uses, and neither is Deno-specific.
- The child's *source* is the harder half. `spawn` takes JavaScript, and in a page there is no
  filesystem to have read it from — so `$WACPATH` would have to mean the Origin Private File
  System, and something would have to put a built worker bundle there. `box`'s own applets are
  linked into the page already, which is why the in-process route was worth having first.

The awkward part is not the worker, it is that the parent must not be parked in `Atomics.wait`
while its child needs answering. The child's calls are answered by the *page*, not by the parent,
so this may already be fine — worth confirming before designing anything, because if it is, the
work is mostly wiring.

## Also worth fixing while in here

A spawned program inherits the *host's* working directory rather than the shell's, so
`cd sub; prog f` looks in the wrong place. `pushChild` takes a `cwd` for exactly this reason and
`spawn` has nowhere to put one. Adding a directory to `spawn` would fix the in-process and the
spawned case the same way, and is a smaller change than it sounds.

Related: [0028](0028-sh-decides-nothing-about-what-wacpath-programs-may-do.md), which is the
grants half of the same question and is still nobody's decision.

## Half done, 2026-08-04 (agent-a)

**A page spawns now.** `browserWorld` implements `SPAWN`, `CLOSE_FEED`, `EXIT_CODE`, and the child
half of `SEND`, `RECV` and `CLOSE_SOCKET`, through the same `spawnChild` the Deno host uses — the
guesses in the section above were right, and it was mostly wiring: `children.ts` needed only the
worker creation lifted out into an argument, since a page and Deno make one the same way.

Proven in a real Chromium rather than against the double, in `platform/test/browser_live.test.ts`: a
`--worker --target browser` bundle of `wc.wac` is written into the Origin Private File System by the
test, `runner.wac` reads it and spawns it, and the answer is compared against the same program built
for Deno. A worker created by a worker, its own `SharedArrayBuffer`, and its calls answered by the
page while its parent is parked.

Node got the same treatment in the same change, so all three hosts spawn from one implementation.

**What is still missing is the other half of this issue: a page has nothing to spawn.** The gap named
above — "`$WACPATH` would have to mean the Origin Private File System, and something would have to put
a built worker bundle there" — is exactly what remains, and it is why `packages/box`'s applets are
still linked into the browser terminal in-process. The promising route is the one that needs no
filesystem at all: every built program already carries its own worker bundle, and `box` dispatches on
argv, so "run me again with these arguments" would give a page sixty real programs. That is what to do
next, and it works identically under Deno.

Also still true: a spawned program inherits the host's working directory rather than the shell's.
