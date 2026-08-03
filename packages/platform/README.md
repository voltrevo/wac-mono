# platform

A capability world for wac applications, so a program can be written **entirely in wac** —
no TypeScript of its own — and still read files, tell the time and print output.

```sh
deno task app packages/platform/example/wc.wac --allow-read -- README.md
```

`example/wc.wac` is the whole application. There is no `main.ts` beside it.

That command **builds and runs** — it is a shortcut, not a second runtime. There used to
be a separate `runApp` that compiled and spawned a worker by a route of its own, which
meant two launchers and two workers: a dev loop that could be green while the shipped
artifact was broken, and a change to the application contract that had to be made twice.
Now there is one path, and the dev loop exercises it.

A package of [wac-mono](../../README.md) — see the root README for layout and how to run
things. All commands run from the repo root.

## Building an executable

```sh
deno task app:build packages/platform/example/wc.wac --allow-read -o wc
./wc README.md
```

27K, self-contained: the wasm is base64 inside it, and so are the bindgen wrappers and the
whole host. Nothing is read from this repo at run time, so the file can be copied anywhere
Deno exists.

**Capabilities are granted at build, not at run.** The built program takes no permission
flags of its own and every argument goes to the application, so it behaves like any other
program. Whoever packages it decides what it may do; whoever runs it cannot widen that.
The same source built without `--allow-read` reports `filesystem read not granted` and
exits 1, and no argument can put the capability back.

**The shebang is exactly the grants.** A program granted nothing asks for nothing:

```
#!/usr/bin/env -S deno run                    # no capabilities
#!/usr/bin/env -S deno run --allow-read       # built with --allow-read
```

That is worth the trouble it took. The obvious way to spawn the worker is
`new Worker(import.meta.url)` — the file spawning itself — but that needs `--allow-read`
on the file, which put a permission in every shebang whatever the program could do, and
read as a filesystem grant to anyone auditing it. So a built program carries the worker's
source as a string and spawns it from a blob URL, which needs no permission at all.

The build is two passes for that reason: the worker bundle holds the application and the
wasm, and the launcher carries it as a string.

## Node

```sh
deno task app:build packages/platform/example/wc.wac --allow-read --target node -o wc
./wc README.md
```

The same wac, the same wasm, the same bridge and opcodes; a dozen closures and the thread
API differ. Node's `worker_threads` takes source directly with `{ eval: true }`, which
suits a bundled program better than a blob URL since there is no URL to make, and Node 22
runs an extensionless file as ESM with top-level await, so a built program is still `./wc`.
A test builds both targets and checks they print the same bytes.

**Node has no permission system, so the capability world is the whole boundary there.**
Under Deno a build that withholds the filesystem is enforced twice — by the world and by
the process — and under Node only once. The shebang is plain `#!/usr/bin/env node`,
because there is nothing for it to state. An application that is denied a capability still
gets `not granted` and exits 1; what is missing is the second line of defence if the
launcher itself were wrong.

The bundle spawns **itself**: a single file cannot reference a sibling worker module, so
`new Worker(import.meta.url)` re-runs it, and it notices it is on a worker and runs the
application rather than launching one. A shebang does not stop a file being loaded as a
worker module — that was checked, not assumed.

## The idea

wac has no ambient access. There is no import a program can name, no global reaching
outside, so an application can only touch what it is handed. The two structs in
`src/platform.wac` are therefore not a convention but a **complete statement of what a
program can do**:

```wac
export i32 main(Core core, Cli cli) { … }
```

Reading `main`'s parameters tells you the application reads the clock, prints, and touches
the filesystem. Nothing else is reachable, because there is nowhere else to reach.

It was a struct with `start` and `run` at first. That bought nothing: a program that runs
once and exits has no state to keep between calls, so the struct was ceremony around a
function. A *service*, called repeatedly, will want one — and can have it then.

`Core` is what every host provides — clock, monotonic clock, secure random, output. `Cli`
is arguments, the standard streams and the filesystem, which a browser has none of; that
split is why it is a second struct rather than more fields.

| | capability | grant |
|---|---|---|
| `Core` | `nowMillis`, `monotonicNanos`, `randomBytes`, `log`, `warn` | — |
| `Cli` | `argCount`, `arg`, `env` | — |
| | `readStdin`, `write` | — |
| | `openInput`, `readChunk` | `--allow-read` for a file |
| | `readFile`, `stat`, `readDir` | `--allow-read` |
| | `writeFile`, `mkdir`, `remove`, `rename` | `--allow-write` |
| | `openOutput` (to a file) | `--allow-write` |
| | `connect`, `listen`, `accept`, `recv`, `send`, `closeSocket` | `--allow-net` |

**`readStdin` and `write` need no grant**, for the same reason `arg` does not: what the
user pipes in and what the program prints are the user's own doing, not a reach into
something they did not offer. `write` puts *exactly* those bytes on standard output —
`log` is for lines of text, and without a byte-level output nothing could emit binary,
which ruled out every compressor and encoder as a filter.

**`openInput` and `readChunk` are the incremental half.** Everything else answers with the
whole of something, which is fine for a filename and wrong for a pipe: `cat` of a large
file held it entirely in memory, and so did every filter. `openInput("")` selects standard
input and a path selects that file; `readChunk` pulls up to 64K and answers empty at the
end.

There is one *current input* rather than a handle per file, and that is forced rather than
chosen: wac has no closures, so nothing can carry a handle into the `fn[u8[]()]` a
transform expects. The state has to live somewhere and the world is the honest place for
it.

The signatures are the reason this composes at all. `gzipStream` takes
`fn[u8[]()]` and `fn[bool(u8[])]`, which is exactly what `readChunk` and `write` are, so
the whole of `box gzip` is:

```wac
return gzipStream(cli.readChunk, cli.write);
```

`write` returns a `bool` for that reason alone — almost every caller discards it. Had the
shapes not matched there would have been no adapter to write.

Measured on one 300MB file, peak RSS: **94MB streaming (`wc`), 1.5GB buffered
(`sha256sum`)**, against a 57MB floor for the Deno runtime itself. Before the conversion
`wc` peaked at 1.5GB on the same input. The streaming ones are `cat`, `wc`, `hex`, `crc32`, `tr`, `strings`, `gzip` and
`gunzip`. `sort`, `tac` and `tail` cannot stream by nature. `sha256sum` and `sha512sum`
still buffer because `packages/crypto` hashes a whole message — an incremental API there
is the next thing worth having.

**Sockets are handles, not a current-socket.** `openInput` and `openOutput` are
one-at-a-time because the wac side has no closures to carry a handle into the `fn[u8[]()]`
a transform expects; an `i32` in a struct has no such problem, and a server needs a
listener and a connection open at the same time, so a current-socket could not express it.

`connect` resolves and dials, `listen` binds, `accept` blocks until someone arrives, and
`recv` answers empty when the peer closes — a short read means nothing, exactly as for a
file. **There is no `poll`**, so a program waits on one socket at a time. That is enough
for a request/response protocol and for a server handling one connection at a time; it is
not enough for a proxy, or for anything watching two sockets at once. `box nc` is the
applet that would need it, which is why there isn't one.

The payoff is that `packages/server` and `packages/http` needed no changes at all.
`serve(input, now)` was already a pure state machine — bytes in, a response and a consumed
count out — so `box serve` is a thirty-line socket loop and nothing in that package knows
a socket exists.

**`mkdir`, `remove` and `rename` are one tier, not three conveniences.** `writeFile`
alone cannot express a safe update: it truncates and then fills, so a reader arriving in
between sees a half-written file and a crash leaves one. With `rename` an application can
write beside its target and move it into place, which on every filesystem this runs on is
atomic — `packages/box`'s `lib/safe.wac` is that, in fifteen lines, and `cp` uses it. Both
recursive forms (`mkdir -p`, `rm -r`) have to be asked for, because the recursive form is
the one that can destroy something it was not pointed at.

What is still missing is metadata: there is no way to set a modification time, so `touch`
creates an empty file and leaves an existing one exactly alone rather than rewriting it to
move its mtime. The applet says so instead of pretending.

`example/hexdump.wac` exercises the difference: `hexdump < file` reads standard input and
writes exact bytes, and `hexdump <dir>` lists a directory through `stat` and `readDir`.

`packages/box` is the widest consumer of all this — forty-two applets in one program, and
the differential suite that keeps them honest.

## Calls are tickets

Every capability that produces a value hands back a `Pending<T>` rather than the value:

```wac
Pending<FileResult> a = cli.readFile("one");
Pending<FileResult> b = cli.readFile("two");   // both are already running
FileResult ra = a.wait();
FileResult rb = b.wait();
```

`.wait()` blocks and takes the answer, `.isDone()` never blocks, `.cancel()` detaches. The
swap from the old surface was `x(…)` to `x(…).wait()` and nothing more, across 178 call
sites.

Two capabilities are **not** tickets, and the second reason is the binding one. `log` and
`warn` return nothing — a ticket for a line of output is noise at 114 call sites for
something no program will overlap. `readChunk` and `write` stay blocking because they act
on the *current* stream, which the world keeps in order anyway, and because they are handed
to this repo's streaming transforms as bare function references —
`gzipStream(cli.readChunk, cli.write)` wants `fn[u8[]()]` and `fn[bool(u8[])]`. A
ticket-returning capability does not match those, and wac has no closures, so there would
be no adapter to write.

The rule that fell out: the capabilities worth a ticket are the ones that **name their
target** — `readFile(path)`, `stat(path)`, `recv(handle)`, `connect(host)`.

**`waitAny` is the point of all of it.** Overlapping two reads is a convenience; parking
until whichever of two *sockets* speaks first is the difference between a program being
writable and not:

```wac
Pending<u8[]> ra = cli.recv(a);
Pending<u8[]> rb = cli.recv(b);
i32 first = cli.waitAny(i32[](ra.id, rb.id));   // parks; returns 0 or 1
```

It takes ticket ids of any mixed `Pending<T>`, and it reaches no further than this worker's
own memory — the wait is on the completion counter the host bumps, so it consumes no slot
and cannot deadlock the ring. `nc`, an SSH relay and a shell all needed this and none of
them could be written before it; polling `isDone` in a loop burns a core to avoid parking.

Underneath, the bridge is a ring of four slots rather than one mailbox — see `layout.ts`.
`Atomics.wait` takes a single address, so "wait until any of these finishes" is a wait on
one completion counter followed by a rescan, which is also exactly what `poll` over sockets
is. `hostCall` is still submit-then-collect and does the same atomics the single mailbox
did, so nothing that has no reason to overlap pays for the ability to: about 3% on this
package's suite.

## What the boundary is, and is not

The `Cli` and `Core` structs are the complete list of what an application can reach, and
for a **wac** application that is enforced by the language: wac has no ambient anything, so
the only way out of a module is the `fn[…]` capabilities it was handed. A wac program
cannot call `Deno.readFile` because there is no way to write it.

It is *not* enforced by the runtime. The launcher spawns its worker as
`new Worker(url, { type: "module" })`, which inherits the process's grants, so JavaScript
running in there could reach past the world. Nothing does — the code in the worker is
generated by this package — but the distinction matters if anything ever puts other
people's JavaScript on that thread. Dropping the permissions is possible on Deno
(`deno: { permissions: "none" }`, measured to work) but needs `--unstable-worker-options`,
which would put a non-capability flag in the shebang of every program; the shebang saying
exactly what a program can reach is worth more than closing a hole nothing is reaching
through.

Node has no permission model at all, and a browser worker has the origin's authority, so
neither could enforce it even in principle. The language is the boundary on all three.

## The browser

```sh
deno task app:build packages/platform/example/wc.wac --target browser -o wc.html
box httpd -8080 . -x        # -x sends the two headers a page needs
```

One self-contained page, 72K for `wc`: the launcher inline, the worker as a string inside
it, the wasm inside that. The bridge needed **no changes at all** — `layout.ts`, `call.ts`
and `respond.ts` are shared verbatim and contain no reference to any host, because a page
with a worker is exactly the shape they already assume: a thread that may block and a
thread that may not.

What the translation costs is the interesting part, and it is not the plumbing:

| capability | in a page |
|---|---|
| `nowMillis`, `monotonicNanos`, `randomBytes`, `log`, `warn` | unchanged |
| `arg`, `argCount` | from the query string, `?a=first&a=second` |
| `write` | appends the exact bytes to the page |
| `readFile`, `writeFile`, `stat`, `readDir`, `mkdir`, `remove`, `openInput`, `readChunk`, `openOutput` | the Origin Private File System |
| `rename` | **a copy and a delete, so not atomic** |
| `readStdin` | always empty |
| `env` | every variable unset |
| `connect`, `listen`, `accept`, `recv`, `send` | **refused** |

**A page has no TCP**, and that is the finding. `fetch` is not a socket and neither is a
WebSocket, so `connect` is absent rather than approximated — an application gets an error
it can report instead of one protocol that works by accident. `box get`, `box gets` and
`box serve` do not run here, and no amount of shimming would change that.

**`rename` is the promise a page cannot keep.** OPFS has no rename, so it is a copy and a
delete. Atomicity is the entire reason `rename` exists — `cp` and `sponge` write beside
their target and move it into place — so those applets are genuinely weaker in a browser
than on a filesystem, and there is nothing this side can do about it.

`SharedArrayBuffer` needs the page cross-origin isolated, so the launcher checks
`crossOriginIsolated` first and names the two headers rather than letting `newBridge`
throw a bare TypeError. `box httpd -x` sends them, which makes the whole loop wac: a wac
server delivering a wac application to a browser.

**Not run in a browser.** There is none in this container. `test/browser.test.ts` drives
every handler over an in-memory OPFS, which is where a mapping bug would be; what is
untested is `SharedArrayBuffer`, `Atomics.wait` on a real worker, and the page's own
plumbing — all of it shared verbatim with the two targets that *are* tested. That is an
argument rather than a proof, and it is worth someone opening the page once.

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
host/node.ts        the same table over Node's APIs
host/entryNode.ts   the launcher and worker halves for Node
host/entry.ts       the launcher and worker halves of a built program
build.ts            builds an application into one executable
app.ts              build and run, in one step
example/wc.wac      an application, entire
```

## Writing one

Export `main(Core, Cli) -> i32` and return an exit code. That is the whole contract —
nothing to re-export, nothing to register.

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

- **A browser provider.** Deno and Node are done; a browser needs cross-origin isolation
  for `SharedArrayBuffer`, and has no filesystem or argv, so it is `Core` alone.
- **A service shape.** `run(this) -> i32` is the CLI application. A long-running server
  wants `onBytes(this, u8[]) -> Served`, which `packages/server` already defines and drives
  from its own host; folding it into the launcher is the next step.
- **Outbound network.** Nothing prevents it — the bridge makes `fetch` expressible — but no
  capability for it has been designed, and it is the one most in need of a considered
  answer about what an application should be able to reach.
