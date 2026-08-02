# platform

A capability world for wac applications, so a program can be written **entirely in wac** —
no TypeScript of its own — and still read files, tell the time and print output.

```sh
deno task app packages/platform/example/wc.wac --allow-read -- README.md
```

`example/wc.wac` is the whole application. There is no `main.ts` beside it.

A package of [wac-mono](../../README.md) — see the root README for layout and how to run
things. All commands run from the repo root.

## The idea

wac has no ambient access. There is no import a program can name, no global reaching
outside, so an application can only touch what it is handed. The two structs in
`src/platform.wac` are therefore not a convention but a **complete statement of what a
program can do**:

```wac
export struct App {
  Core core;
  Cli cli;
  App start(Core core, Cli cli) { return App(core, cli); }
  i32 run(this) { … }
}
```

Reading `start`'s parameters tells you the application reads the clock, prints, and
touches the filesystem. Nothing else is reachable, because there is nowhere else to reach.

`Core` is what every host provides — clock, monotonic clock, secure random, output. `Cli`
is arguments, environment and files, which a browser has none of; that split is why it is
a second struct rather than five more fields.

## How an asynchronous host looks synchronous

`readFile` is `await Deno.readFile` on the main thread. From wac it is a function call:

```wac
FileResult f = this.cli.readFile(path);
```

The application runs on a **worker**, because a worker is allowed to block. The capability
closure writes its request into a `SharedArrayBuffer` and calls `Atomics.wait`, which parks
the thread *with the wasm frame still on its stack*. The main thread is parked on the same
memory with `Atomics.waitAsync`, so it never blocks: it wakes, does the asynchronous work,
writes the answer back and notifies. The worker resumes and returns.

`packages/stream` proved this mechanism for a byte pipe; this generalises it to
request/response so any capability can use it. **Requests travel through the buffer, not
through `postMessage`** — a blocked worker cannot deliver a message, which is the deadlock
`stream`'s README warns about.

There is a test for the part that matters: a handler that takes 50ms of real asynchronous
time, with the main thread counting timer ticks throughout. The worker waits; the main
thread keeps running.

## Layout

```
src/platform.wac    the world: Core, Cli, FileResult
host/layout.ts      the shared-memory layout, in one place
host/call.ts        the worker side — hostCall, which blocks
host/respond.ts     the main-thread side — serves calls without blocking
host/provider.ts    builds Core and Cli from a bridge
host/deno.ts        Deno's implementations. Note how much of it is `await`
host/worker.ts      loads an application and runs it
host/launch.ts      compiles, spawns the worker, answers, waits
app.ts              the command line
example/wc.wac      an application, entire
```

## Writing one

Export an `App` struct with `start(Core, Cli)` and `run(this) -> i32`. Return an exit code.
To use `readFile`, also export `fileResult` — a struct has no constructor JavaScript can
reach, so building one is wac's job:

```wac
export FileResult fileResult(bool ok, u8[] bytes, string error) {
  return FileResult(ok, bytes, error);
}
```

Testing needs no worker and no files: build `Core` and `Cli` from wac closures returning
fixtures, call `run`, and assert on what the fake `log` collected. The capability record
makes an application a pure function of its world.

## Rules that are not style

**Capabilities return values; they never fill buffers.** Arrays *copy* across the
boundary, so `fn[void(u8[])] fill` type-checks and quietly does nothing — the host's writes
land on a copy.

**Capabilities are coarse.** Behind each is a thread parking and unparking: nothing per
file read, ruinous per byte. `readFile`, never `readByte`.

**Capability closures are built once per application, never per call.** bindgen registers
each distinct function identity in a table of sixteen per signature and never frees a slot,
so a fresh closure per call dies on the seventeenth with a `RangeError` far from its cause.

**One thing at a time.** While the application is parked in a capability, nothing else can
enter it. Concurrency means more instances.

## What is not here yet

- **Node and browser providers.** `host/deno.ts` is the only world; the bridge and the
  provider are host-agnostic, so another is a file of closures. A browser additionally
  needs cross-origin isolation for `SharedArrayBuffer`.
- **A service shape.** `run(this) -> i32` is the CLI application. A long-running server
  wants `onBytes(this, u8[]) -> Served`, which `packages/server` already defines and drives
  from its own host; folding it into the launcher is the next step.
- **Outbound network.** Nothing prevents it — the bridge makes `fetch` expressible — but no
  capability for it has been designed, and it is the one most in need of a considered
  answer about what an application should be able to reach.
