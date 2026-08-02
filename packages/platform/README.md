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

**`mkdir`, `remove` and `rename` are one tier, not three conveniences.** `writeFile`
alone cannot express a safe update: it truncates and then fills, so a reader arriving in
between sees a half-written file and a crash leaves one. With `rename` an application can
write beside its target and move it into place, which on every filesystem this runs on is
atomic — `example/box/lib/safe.wac` is that, in fifteen lines, and `cp` uses it. Both
recursive forms (`mkdir -p`, `rm -r`) have to be asked for, because the recursive form is
the one that can destroy something it was not pointed at.

What is still missing is metadata: there is no way to set a modification time, so `touch`
creates an empty file and leaves an existing one exactly alone rather than rewriting it to
move its mtime. The applet says so instead of pretending.

`example/hexdump.wac` exercises the difference: `hexdump < file` reads standard input and
writes exact bytes, and `hexdump <dir>` lists a directory through `stat` and `readDir`.

## box: forty-two applets in one program

```sh
deno task app:build packages/platform/example/box/box.wac --allow-read --allow-write -o box
./box grep -i wac README.md
cat README.md | ./box sort -u | ./box wc -l
./box du packages
./box gzip data | ./box gunzip | ./box sha256sum
```

```
base32 base64 basename cat cp crc32 cut date dirname du echo false fold
find grep gunzip gzip head hex ls mkdir mv nl rev rm rmdir seq sha256sum
sha512sum sort strings tac tail tee touch tr true uniq urldecode
urlencode wc
```

111K, drawing on this repo's `crypto`, `codec`, `regex`, `gzip`, `datetime` and `url`
packages, so it is the widest composition here.

**Several applets are a few lines over a package.** `gzip` is `gzipBest`, `date` is the
clock capability and `rfc3339.format`, `crc32` and `urlencode` likewise. Those packages
were written to be called from TypeScript through bindgen and needed no change at all to
become the inside of a program instead — which is the thing worth showing.

**One applet per file.** `applets/<name>.wac`, always — finding one takes no thought, and
two people editing different applets do not collide in a 561-line file. `box.wac` is the
dispatcher and its forty imports are the table of contents; shared parts live in
`lib/` (`args`, `bytes`, `num`, `lines`, `input`). Splitting thirty files cost 12ms of
build time, measured before and after.

`true` and `false` are the exception: the dispatcher returning a constant *is* the whole
applet, and a file containing one `return` would be ceremony rather than clarity. Its tests are differential against the system tools rather than against
my idea of them: `cat rev nl tac sort sort -r sort -u uniq -c base32 base64 sha256sum
sha512sum grep grep -i grep -v grep -n grep -c find` all match byte for byte, `du` matches
`du -sb`, and `head -N`, `tail -n N`, `wc -l/-w/-c` match the real ones' output. `grep`
returns 1 on no match and 2 on a bad pattern, as it should. The second batch is checked the
same way: `cut -d -f`, `tr` with ranges, `fold -w` and `strings -n` against the system
tools, and `gzip`/`gunzip` against the system `gzip` in *both* directions, so neither side
can be wrong in a way the other cancels out.

Three things it exercises that nothing else did. **One shared option parser** — without it
`head` was fixed at ten lines and `wc` could not do `-l`, so a dozen applets were
approximate rather than real. **A recursive walk**, in `find` and `du`, which is the first
thing to push on `readDir` and `stat` beyond one level. **The write path**, in `cp` and
`tee`; `cp` needed no new capability at all, being `readFile` and `writeFile` — though it
is now `readFile`, `writeFile` and `rename`, so that an interrupted copy cannot leave a
half-written destination.

**It also shows what a multicall binary costs.** `box`'s grants are the *union* of what
its applets need, so `box echo` carries the filesystem access `box cat` wants. Built as
separate executables, each would state its own: `wc` needs nothing at all and its shebang
would say `deno run` with no flags. One binary with forty-two entry points is the shape
BusyBox has to take; it is not the shape this model is best at.

`bin/` shows the other shape, and measures it rather than asserting it. Four applets are
also built alone — the entry point is four lines and imports the applet file unchanged:

| built alone | shebang | size |
| --- | --- | --- |
| `wc` | `#!/usr/bin/env -S deno run` | 47K |
| `sha256sum` | `#!/usr/bin/env -S deno run` | 51K |
| `grep` | `#!/usr/bin/env -S deno run --allow-read` | 59K |
| `cp` | `#!/usr/bin/env -S deno run --allow-read --allow-write` | 47K |
| `box` | `#!/usr/bin/env -S deno run --allow-read --allow-write` | 111K |

`wc` and `sha256sum` come out with **no permissions at all** — they read standard input
and write a line, and a program that only does that needs nothing from anyone. Handed a
filename, that `wc` says `wc: README.md: filesystem read not granted` and exits 1; it
cannot be talked past its shebang. Under `box` the same applet carries `--allow-write`,
because `cp` is in the binary.

That is also why `Args` carries a `name`. A program in this model is never handed its own
argv[0] — argv starts at its first real argument — so the standalone `wc` would otherwise
have reported errors as `box:`. Under `box` the name is the applet's; in `bin/` the entry
point passes it.

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
