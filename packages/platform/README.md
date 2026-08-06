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

An interactive browser application exports `page(Core, Cli, Page)` instead, and the entry
point's name is how a program says which kind it is. A module may export both.

It was a struct with `start` and `run` at first. That bought nothing: a program that runs
once and exits has no state to keep between calls, so the struct was ceremony around a
function. A *service*, called repeatedly, will want one — and can have it then.

`Core` is what every host provides — clock, monotonic clock, secure random, output. `Cli`
is arguments, the standard streams and the filesystem, which a browser has none of; that
split is why it is a second struct rather than more fields.

| | capability | grant |
|---|---|---|
| `Core` | `nowMillis`, `monotonicNanos`, `sleepMillis`, `randomBytes`, `log`, `warn` | — |
| | `waitAny` | — |
| `Cli` | `argCount`, `arg`, `env` | — |
| | `readStdin`, `write`, `writeErr` | — |
| | `openInput`, `readChunk`, `outputError` | `--allow-read` for a file |
| | `readFile`, `stat`, `linkStat`, `readDir` | `--allow-read` |
| | `writeFile`, `mkdir`, `remove`, `rename` | `--allow-write` |
| | `openOutput` (to a file) | `--allow-write` |
| | `connect`, `listen`, `accept`, `recv`, `send`, `closeSocket` | `--allow-net` |
| | `spawn`, `closeFeed`, `exitCode` | — (the child gets what you pass, never more) |
| | `cwd` | — (a read; there is no `chdir`) |
| | `pushChild`, `popChild` | — (a child *inside* this program, with this program's authority) |
| `Page` | `render`, `setText`, `setValue`, `getValue`, `on`, `nextEvent`, `title` | browser only |
| | `drawPixels`, `nextFile`, `offerDownload` | browser only |

**Anything that can fail says why.** `writeFile`, `mkdir`, `remove` and `rename` answer a **`Change`**:
a fault category and the host's own words. A `bool` could report that a write failed and never what
went wrong, so `rm -f` had to suppress every failure or none. A message alone was better and still not
enough — "was it merely absent?" could only be answered by matching English, which is a guess about
three operating systems, so `rm -f` asked `stat` first instead and raced with whoever else was
deleting. The category answers it in the reply: `ok()`, `absent()`, and `fault` against `FAULT_DENIED`,
`FAULT_EXISTS`, `FAULT_NOT_EMPTY`, `FAULT_OTHER`. The classification is one file,
[`host/faults.ts`](host/faults.ts), shared by all three hosts — Deno's typed errors, Node's `code`s and
the browser's `DOMException` names are three vocabularies for the same five facts, and `rm -f` must
mean the same thing on all of them.

The categories are deliberately few, and `FAULT_OTHER` is not an embarrassment: a full errno table is
a taxonomy nobody branches on. What a program branches on is "was it already gone"; what a person
reads is the message.

**Everything that fails carries one, not only the four that answer with a `Change`.** A capability that
fails does so by throwing, and the bridge's error envelope now begins with the category byte — so
`HostCallError` has a `fault`, `FileResult` has a `fault`, and the classification happens once in
`respond.ts` rather than at each of the forty handlers. The reads needed it as much as the writes:
`packages/sh`'s nine file-reading programs printed "No such file or directory (os error 2): readfile
'/tmp/x/missing'" where GNU prints four words, and the sentence differed by runtime — Node says
"ENOENT: no such file or directory, open '…'" for the same fact. All nine now match GNU's stderr line
for line, which a differential test checks against the installed coreutils.
[0062](../../issues/closed/0062-a-read-failure-has-no-fault-category-so-nine-programs-print-the-hosts-wording.md).

**In a browser the message is the category's own short phrase**, not the `DOMException`'s — for a
failed *read* as much as a failed change, since one tab speaking two ways about the same failure is
worse than either way. A read reports by throwing, so the rephrasing happens where the throw does; a
fault the host *named itself* keeps its own words, because "filesystem read not granted to this
application" says the page withheld the capability and "permission denied" says a filesystem refused an
operation, and only one of those is true. Deno and
Node say "No such file or directory (os error 2), remove '/tmp/x'" — terse, and it names the path and
the operation, so it is worth passing on verbatim. A browser says "A requested file or directory could
not be found at the time an operation was processed.", which is prose for a developer console and
names neither; after `rm: cannot remove 'f': ` it reads as a defect. Since the category is already
established by then, the short form loses nothing — and `FAULT_OTHER` still keeps the message, because
there the message is the only information there is. Checked against a real Chromium and not only
against the in-memory double, since this is exactly the sort of thing a double agrees with itself
about.

**`readChunk` and `recv` answer a `Read`**, which is `Data(bytes)`, `End`, or `Failed(why)` — three
states in the type, so a caller cannot mistake a broken read for the end of the input. `match` is
exhaustive; ignoring `Failed` does not compile.

That is the second design. The first added a companion `inputError()` to ask *after* an empty answer,
which was cheaper and wrong: it left the ordinary path looking exactly as correct as it had been, so
anybody who forgot to ask got the old bug back — a filter over a disk that gave out exiting 0 having
written half the answer. Removing a failure mode is worth more than the twenty call sites it cost,
and in a young codebase those call sites are a schedule rather than an objection.

`Read` lives in `packages/bytes`, not here, because `gzipStream(cli.readChunk, cli.write)` hands the
capability straight to a transform — wac has no closures, so no adapter can sit between them, and
`gzip` has no business depending on a capability world. The lowest package in the tree is where both
sides can reach it.

`write` keeps its `bool` and has `outputError()` beside it, because its two outcomes are *not* the
same shape of question: a reader that went away is a normal ending a filter should exit 0 on, and a
failed write is not. That one is a companion on purpose rather than by inertia.

`stat` follows symbolic links, so it describes what a name leads to; `linkStat` describes the name.
Both questions are real — `find` wants the first, `tar` wants the second — and a flag would have made
every caller decide something most of them do not care about.

`Stat` carries a **fault**, and the split is narrow on purpose: *absence is an answer*, so a path with
nothing at it gives `exists = false` with `FAULT_NONE`, and so does a path through a file — bash calls
`test -e f/g` false rather than an error, and every "does it exist" check in the tree depends on that
staying ordinary. A fault means the question could not be *reached*: `FAULT_DENIED` where the world has
no read capability, and `FAULT_NOT_REPRESENTABLE` for a name the host cannot express. Before it, both
arrived as `exists = false` — a program with no read grant was told a file was not there, which it had no
way to tell from a file it was not allowed to look at. Callers read `st.answered()` before trusting
`exists`, and `faultWords(fault)` turns the category into the words the real tools use. wac-mono 0065.

`pushChild` and `popChild` need no grant because they add no authority: they change what `arg`,
`readChunk`, `write`, `log`, `warn` and every path mean *for the program itself*, between two
calls it makes. A shell uses them to run a program and keep its output — see
[`example/inside.wac`](example/inside.wac), and `packages/box`'s applets running inside
`packages/sh`. They are emphatically **not** isolation: the child is the same wasm instance with
the same grants, and the thing with a real boundary is `spawn`.

`waitAny` is in `Core` because it grants nothing — it cannot start work, only notice that some
has finished — and `spawn` needs no grant of its own for the same reason the child's grants are
an argument to it: what a child may do is a subset of what its parent already had.

`Page` is a third profile and only a browser provides it. A page capability that pretended to
work in a terminal would be a lie, which is the whole reason these are separate structs.

**`readStdin`, `write` and `writeErr` need no grant**, for the same reason `arg` does not: what the
user pipes in and what the program prints are the user's own doing, not a reach into
something they did not offer. `write` puts *exactly* those bytes on standard output —
`log` is for lines of text, and without a byte-level output nothing could emit binary,
which ruled out every compressor and encoder as a filter.

`writeErr` is that for standard error, and `warn` is the line. The two are different jobs: `warn` is
the program talking about itself, which is what every applet in `packages/box` does and should keep
doing; `writeErr` is the program passing someone else's bytes through. `packages/ssh` is why it
exists — a remote command's two streams arrive interleaved and tagged, and with only `warn` the
client could reproduce standard output exactly and standard error not at all, since a per-packet
`warn` inserts a newline at every packet boundary and buffering to the end loses the order. Both
`packages/sh` and `packages/ssh` used to flush the whole error stream at the end with its trailing
newline shaved off by hand; both now write it when it happens. Issue 0014.

**`openInput` and `readChunk` are the incremental half.** Everything else answers with the
whole of something, which is fine for a filename and wrong for a pipe: `cat` of a large
file held it entirely in memory, and so did every filter. `openInput("")` selects standard
input and a path selects that file; `readChunk` pulls up to 64K and answers empty at the
end.

There is one *current input* rather than a handle per file, and that is forced rather than
chosen: the transforms take `fn[u8[]()]`, which has no parameter to carry a handle into. A
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

Measured on one 300MB file, peak RSS: **94MB streaming (`wc`)**, against a 57MB floor for the
Deno runtime itself. Before the conversion `wc` peaked at **1.5GB** on the same input.

Most of `box` streams — through `openInput`/`readChunk` directly, or through its own line reader
built on them. Two joined later and are worth naming because the reason was never the transport:
`sha256sum` and `sha512sum` buffered until `packages/crypto` grew `create`/`update`/`finish`, and
`tail` buffered until it was clear that a ring of N lines is not the same as holding the file.
What genuinely cannot stream is what has to see everything before it can answer a single byte —
`sort`, `tac`. Each applet's header says which it is and why, which is the copy that stays
current; an enumeration here went stale twice.

**Sockets are handles, not a current-socket.** `openInput` and `openOutput` are
one-at-a-time because the transforms take `fn[u8[]()]`, which has no parameter to carry a
a transform expects; an `i32` in a struct has no such problem, and a server needs a
listener and a connection open at the same time, so a current-socket could not express it.

**`listen` takes the address to bind, and it is not optional.** It took a port alone until issue
0025, and the host bound `0.0.0.0` — so every server written here was reachable from every interface
and no program could ask for loopback. For most servers that is a deployment surprise; for
`packages/tor`'s SOCKS proxy it was the difference between serving the person at the keyboard and
running an open proxy that sources strangers' traffic out of somebody else's exit node, which is why
every other SOCKS implementation binds loopback. `"127.0.0.1"` is loopback, `""` is every interface —
the old behaviour, spelled out rather than defaulted into, so the surprising one is something somebody
typed. `accept` answers with the peer's address beside the handle, and `Socket.fromLoopback` is the
check that makes a wide bind survivable.

**`Socket.port` is what a socket was given**, which is what makes port 0 worth asking for. A program
that wants a free port cannot pick one — the whole point is that it does not know which are taken —
and `listen` used to answer with a handle alone, so asking for 0 got a listener on a port nobody could
name. `platform/test/listen.test.ts` said so in a comment above three hardcoded port numbers, one of
which collided with another agent's suite run on this machine and failed a push over nothing. Now the
reply carries the handle, this socket's own port, and the peer: `listen(…, 0)` is answerable,
`connect` reports the ephemeral port it dialled *from*, and every test in that file asks the kernel
for a port like any other program would. `box nc -0 -l` prints the port it landed on.

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
ticket-returning capability does not match those, and `fn[u8[]()]` has no parameter, so
be no adapter to write.

The rule that fell out: the capabilities worth a ticket are the ones that **name their
target** — `readFile(path)`, `stat(path)`, `recv(handle)`, `connect(host)`.

**`waitAny` is the point of all of it.** Overlapping two reads is a convenience; parking
until whichever of two *sockets* speaks first is the difference between a program being
writable and not:

```wac
Pending<u8[]> ra = cli.recv(a);
Pending<u8[]> rb = cli.recv(b);
i32 first = core.waitAny(i32[](ra.id, rb.id), -1);   // parks; returns 0 or 1
```

**It lives on `Core`, not `Cli`.** It grants nothing — it cannot start work, only notice that
some has finished — and it is the same in every host. It began on `Cli`, which left an
interactive page unable to wait on a click *or* a dropped file, and that is the question it
exists to answer.

It takes ticket ids of any mixed `Pending<T>`, and it reaches no further than this worker's
own memory — the wait is on the completion counter the host bumps, so it consumes no slot
and cannot deadlock the ring. `nc`, an SSH relay and a shell all needed this and none of
them could be written before it; polling `isDone` in a loop burns a core to avoid parking.

Underneath, the bridge is a ring of 128 slots rather than one mailbox — see `layout.ts`.
`Atomics.wait` takes a single address, so "wait until any of these finishes" is a wait on
one completion counter followed by a rescan, which is also exactly what `poll` over sockets
is. `hostCall` is still submit-then-collect and does the same atomics the single mailbox
did, so nothing that has no reason to overlap pays for the ability to: about 3% on this
package's suite.

### Who owns a slot

Every state change on a slot is a compare-and-exchange, not a store, and every answer is
checked against the slot's **generation** before it is written. That is not defensive style; it
is four bugs, all the same shape — the host and the worker disagreeing about whose call a slot
holds — and all four were live in a bridge whose tests passed:

| what happened | how it showed |
|---|---|
| `claim` published a slot as pending before the opcode was written | `no handler for capability 0` |
| a cancelled call's answer written into the slot another call had claimed | issue 0023: a 30-second bound expiring after 15 |
| `take` overwrote a cancel with `RUNNING`, so nobody owned the slot | a slot lost for the life of the program |
| `reply` overwrote a cancel with `READY`, same result | a slot lost, and the answer unclaimable |

The last two are invisible until the ring runs out, and then the failure is a park in whatever
call happens to be next. The first was unhittable at four slots and appeared within three suite
runs at sixteen slots. Only the second was ever reported from the field, and only because a tor client
was dropping healthy relays.

So `test/fuzz.test.ts` exists: a seeded random sequence of submit, cancel, collect and waitAny
against a host that answers at delays and sizes the request itself specifies, so the whole thing
is deterministic and a failure replays from its seed. Every request carries a nonce the handler
echoes, which turns cross-talk from something you infer into something the harness catches, and
the run ends by checking that every slot came back free. It caught the third and fourth bugs and
catches all four when they are put back — each with its own signature. Eight seeds in the suite,
about a second; `WAC_FUZZ_SEEDS=250` for a deep sweep, which is what to run after touching
`call.ts`, `respond.ts` or `layout.ts`. The fourth bug was at the eighth seed.

### Deadlines

Nothing bounded how long a capability could take, and a peer that finished the handshake and
then said nothing used to stop an application permanently — no error, no log line, no way to
notice (issue 0018). The fix is a parameter on the wait:

```wac
Pending<u8[]> r = cli.recv(h);
i32 which = core.waitAny(i32[](r.id), 5000);   // -1 when the five seconds run out
if (which < 0) {
  r.cancel();                  // stop waiting for the read
  cli.closeSocket(h);          // ...and stop the read itself
}
```

`millis` of -1 waits as long as it takes, and 0 is a poll: "which of these is ready now, if
any". Not a `recvWithin` — a deadline belongs to the wait rather than to each capability, so
this one parameter bounds `connect`, `accept`, `readFile` or a child's `exitCode` without any
of them knowing what a deadline is. `example/patience.wac` is a worked version.

It costs nothing: `waitAny` was already a park on this worker's own memory, and `Atomics.wait`
takes a timeout, so there is no opcode, no ring slot and nothing to dispose of.

**The first version of this was a timer ticket** — `core.sleepMillis(ms)` in the `waitAny`
list, whichever settles first wins. It worked, and it was wrong in a way worth recording: the
ticket cost a slot, could not be written inline (there would be nothing left to cancel), and
had to be disposed of on every path. Four forgotten ones filled the ring, and the next call
then parked forever — the same silent hang as the bug being fixed, arrived at from the other
side. `sleepMillis` remains in `Core` for *sleeping*, which is a real need and a different one.

What stays the caller's problem, because it is about the call rather than the clock:

- **Cancel is not abort** for a read the host has entered. Closing the handle is what makes it
  finish, and the slot returns then. A timed-out `connect` has no handle yet, so its slot comes
  back only when the host's own attempt does — worth knowing before retrying in a loop, since
  four in flight is the whole ring.
- **To wait longer, re-wait the same ticket.** A second `recv` on a handle whose first is
  outstanding means two reads on one socket and no defined byte order.

**The slot count is also a ceiling on how many handles a program can watch**, since watching N
means N outstanding `recv`s holding N slots, and writing needs one more. It went four → sixteen
→ 128 for that reason: four meant three handles, and `pipe.wac` already watches three, so a
three-stage pipeline could not be written; sixteen meant a relay could not fan in more than a
dozen sockets. Exceeding it is worse than a limit — the held slots are RUNNING, not READY, so it
is indistinguishable from backpressure and parks silently.

**What paid for 128 slots is that a slot no longer owns a buffer.** Sixteen slots × 128KiB was
2MiB of shared memory per bridge whether a program made one call or none, and the natural way to
raise the slot count multiplies it: 128 would have been 16MiB, four times over for a shell with
four applets running. So the payload buffers are **pooled** — eight per direction, taken for the
length of one copy and handed straight back — and a slot is a 32-byte control record with a
4KiB inline area of its own. 2.5MiB against the old 2MiB, for eight times the fan-in.

The inline area is not an optimisation, it is the progress guarantee: **an answer can always be
written.** The first version of the pool deferred an answer that could not get a buffer, and
deadlocked — the buffers are held by answers the worker has not collected, and a worker parked on
one particular call collects nothing, so the answer it waits for never comes. With an inline
area, a pool that is empty costs round trips and nothing else.

How many round trips is the whole question, and 256 bytes — the size it was first written at —
made the fallback a cliff: `bench/ring.ts` measures 300 × 1MiB answers with 32 in flight, and at
256 bytes that cost seven times what 8 in flight did, because every answer past the eighth
crawled 256 bytes at a time. 4KiB is the knee of that curve (1694 → 384ms for +0.46MiB), and it
is why the inline area is sized against the pool's *absence* rather than against a typical
answer:

| inline | 256B | 1KiB | 2KiB | 4KiB | 8KiB |
| --- | --- | --- | --- | --- | --- |
| 300 × 1MiB, 32 live | 1694ms | 712ms | 512ms | 384ms | 300ms |
| bridge | 2.04MiB | 2.13MiB | 2.25MiB | 2.50MiB | 3.00MiB |

Pooling makes ownership shared, which is a new class of bug, and it produced one immediately:
handles were stored as an index with -1 for "none", in memory that starts at **zero**, so every
untouched slot claimed to hold buffer 0 and the first `release` of one handed that buffer back
while a live answer was still in it. The fuzzer read one call's answer out of another's —
`asked as 15, answered as 24` — on its first seed. Handles are one-based now, so zeroed memory
means "none" by construction, and `test/pool_model.test.ts` walks every reachable state of two
slots over one buffer with that bug and its mirror image as mutants.

A ticket abandoned rather than cancelled still fills a slot, so the ring keeps its backstop:
`all 128 call slots hold answers that were never taken, from: RECV × 127, ACCEPT`.
A ready slot can only be freed by the thread that submitted it, so a submitter finding all
every slot ready is provably stuck rather than merely waiting — an error, not a park. It names
the opcodes because the call that discovers the full ring is rarely the one that leaked.

## Spawning

```wac
FileResult prog = cli.readFile("wc.worker.js").wait();
Child kid = cli.spawn(string.fromBytes(prog.bytes), string[]()).wait();

cli.send(kid.handle, "one two three\n".toBytes()).wait();   // its standard input
cli.closeFeed(kid.handle);                                   // ...ends
u8[] said = cli.recv(kid.handle).wait();                     // what it wrote
i32 code = cli.exitCode(kid.handle).wait();
```

**A child is a handle**, like a socket and like standard input. That is the whole design:
`recv`, `send`, `closeSocket` and `waitAny` already worked on handles, so spawning added
`spawn`, `closeFeed` and `exitCode` and nothing else. A shell running `a | b` reads one
handle and writes another; watching a child *and* a socket at once is `waitAny` over two
handles that happen to have different origins.

`spawn` takes JavaScript — a worker bundle, which `--worker` emits:

```sh
deno task app:build packages/platform/example/wc.wac --worker -o wc.worker.js
```

Running a *program* is therefore two steps, read it and spawn it, which is why there is no
registry of launchable things: the capability is "run this", and where the code came from is
the filesystem's business.

**Every host spawns through one implementation.** `host/children.ts` holds it: the queues that are
the child's stdio, the load notice, the grace period, when to stop the responder. What differs between
the three is how a *worker* is made — a page and Deno take a module from a blob URL, Node takes a
source string with `eval` and reports errors through an emitter — so that is an argument, thirty lines
in total, and everything else is shared. The child's world is the other argument, which is how a page
gives its children a page's world and Deno gives them Deno's.

A page could always have done this; nothing about a browser forbade it. A worker can create a worker,
each program needs its own `SharedArrayBuffer` and a responder for it, and the page's own thread hosts
the second as easily as the first — the parent is parked in `Atomics.wait` while its child runs, and
that is fine precisely because the child's calls are answered by the *page*. A child gets no `Page`
profile: its output goes to the parent through the handle, and a child that could draw would be
drawing over the program that started it.

**`spawn` answers only once the source has loaded**, so a file that is not a worker bundle is a
failed child rather than a dead parent. That took two things. Deno re-raises an unhandled worker
error as the *host's* own uncaught error, so a `SyntaxError` in the child killed the program that
spawned it — a shell handed a text file exited 1 with Deno's message and never got to call it a
failed command. And the handle used to be answered before the failure could happen, so `Child.error`
was always empty. The worker now posts a notice as soon as its bundle evaluates, and `spawn` waits
for either that or the load error: a handle means it is running, and -1 with a message means it never
started. Issue 0021.

**A bundle says on its first line that it is one.** `//wac-worker 1`, written by `build.ts` into the
worker source — the same string whether `--worker` puts it in a file or the launcher holds it for
`spawnSelf` — and `spawnChild` checks it before creating anything. So a file that is not a worker
bundle is refused as a *fact about the source*: no worker starts, nothing is inferred from how it
failed, and stderr carries one account of it rather than two. The version is there so a bundle built by
an older wac can be told from a file that was never one.

That is what made the wait safe to fail. The grace used to resolve as *alive*, never as failed, because
a slow load on a busy machine must not be reported as a program that would not start — which left a
file that parses and then says nothing hanging for ever. `ready` is required now, with five seconds
rather than five hundred milliseconds, and its expiry is a failure that names the gap. Module
evaluation is tens of milliseconds; the marker catches the case a timer cannot judge, and the timer
catches what is left. Issue 0033.

**`spawnSelf` is how a page has programs at all.** `spawn` takes a worker bundle, and a bundle comes
from a filesystem — fine on a command line, impossible in a browser tab, where there is no directory
of programs and nothing to have put one there. So a page could spawn and had nothing to spawn.

Every built program already carries its own bundle: the launcher holds it as a string, because that is
how it started the program. `spawnSelf(args, grants)` runs it again with different arguments, needing
no file, no path and no grant of its own — and a program whose `main` dispatches on argv is therefore
sixty programs. That is what `packages/box` is: `box sort` is `box` reading its first argument.

```wac
Child kid = cli.spawnSelf(string[]("sort", "-n"), GRANT_READ).wait();
```

A child runs `main` even when the program also exports `page`, because it was spawned: it has a handle
and nowhere to draw. One bundle can therefore be both a terminal and the programs the terminal runs —
see `packages/platform/example/twin.wac`, which is the whole idea in forty lines, and issue
[0030](../../issues/closed/0030-a-page-cannot-spawn-so-the-browser-shell-runs-applets-in-process.md).

**A child has two handles, because a program has two output streams.** `recv(handle)` is its output
and `recv(errHandle)` is its error output. Merged — which they were until a shell tried it — a
complaint arrives in the pipe: `cat nosuch | wc -c` counted the error message, and `cat nosuch` alone
printed it to standard *output*. A second handle rather than a second capability, so everything that
already works on handles goes on working, `waitAny` above all: a parent can watch a child's two
streams and a socket in one call without knowing which is which.

**A child stands where its parent says.** Both spawn capabilities take a directory: it is where the
child's relative paths resolve from and what its own `cwd()` reports. Empty means the host's own,
which is what a program with no opinion passes. A shell has an opinion, and without this its `cd` was
invisible to everything it ran — `cd sub; prog f` opened `f`.

`closeFeed` is distinct from `closeSocket` because they differ in a way that matters:
`closeFeed` ends the child's standard input, `closeSocket` stops the child. A program that
reads to the end before answering — `wc` — needs the end while it is still alive.

**A child is granted nothing but those streams**, and that is the point of preferring this to
process spawn: what the child may do is the *parent's* choice rather than the operating
system's. `--allow-run=/bin/sh` cannot express that at any granularity. `example/probe.wac`
reports what it can reach, and the difference is measured rather than asserted:

```
probe, built --allow-read --allow-net, run directly   ->  read=ok     net=failed
the same worker, spawned by a parent that has read    ->  read=denied net=denied
```

**A subset is what `grants` is for.** `GRANT_READ | GRANT_NET` and friends, and the host
intersects the request with its own authority rather than trusting it — a parent built without
`--allow-net` cannot hand the network to anyone, and asking is not an error, it simply arrives
denied. Measured four ways in `test/spawn.test.ts`, against one probe:

```
parent --allow-read --allow-net, child asks for nothing     ->  read=denied net=denied
parent --allow-read,            child asks for read         ->  read=ok     net=denied
parent --allow-read --allow-net, child asks for read,net    ->  read=ok     net=failed
parent --allow-read,            child asks for read,net     ->  read=ok     net=denied
```

The first line is the one people expect to be different: grants are opt-in, not inherited. The
last is the ceiling. `failed` rather than `denied` for the third is the probe reporting that it
was allowed to dial and nothing was listening — which is the distinction that makes the table
mean anything.

That is the whole argument for spawning a worker rather than a process. `--allow-run=/bin/sh`
cannot express one readable directory and no network, because there the child inherits the
operating system's authority instead of the parent's.

**It is not a sandbox against arbitrary JavaScript.** A wac child cannot reach past what it
was handed because wac has no ambient anything; JavaScript in a spawned worker inherits the
process's permissions, and dropping them needs `--unstable-worker-options`, which would put a
non-capability flag in the shebang of every program that spawns. So this is a composition and
concurrency primitive, and the grants are meaningful for wac children and advisory for
anything else. wac-mono issue 0015 has the reasoning.

### Composing them

Two examples exist to show that handles compose without any further capability, and both were
written against the world unchanged:

`example/pipe.wac` — `stdin -> child -> child -> stdout`, a shell's `|` with no shell. Three
handles are live at once and the loop waits on whichever moves; it never asks which kind a
handle is, because standard input at handle 0 answers `recv` exactly as a child does.

```sh
printf 'b\na\nb\nc\n' | pipe box.worker.js sort uniq      #  a  b  c
```

Note the deadlock it cannot have: a shell pipeline needs an OS buffer between stages, and a
stage that stops reading while the one before it keeps writing wedges both. Here all three
reads are in flight, so a slow second stage parks the *pump* rather than the first child, and
the ring's four slots are the backpressure. 5MB through `cat | cat` comes out byte-identical.

`example/inetd.wac` — accept a connection, spawn a program, relay bytes until either side
finishes. The handler knows nothing about networks: it reads standard input and writes standard
output. Serving `packages/sh`'s shell this way gives a remote shell whose every command runs
with grants the *server* chose:

```sh
deno task app:build packages/sh/src/sh.wac --worker -o sh.worker.js
inetd 9000 sh.worker.js
```
```
$ printf 'seq 1 20 | grep 1 | wc -l\necho $((6*7))\ncat /etc/hostname\n' | nc 127.0.0.1 9000
11
42
                     # nothing: the shell has no filesystem, though its parent does
```

That last line is the property worth having. It is the artefact issue 0015 predicted — "an SSH
server offering a sandboxed shell where every command is a wac program with grants the server
chose is a thing Unix cannot build" — reachable because a socket and a child are the same kind
of thing.

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

### Interactive pages

A third profile beside `Core` and `Cli`, and only a browser provides it. The entry point says
which kind of program this is: a module exporting `page` gets `Page`, one exporting `main` gets
`Cli`, and a module may export both.

```wac
export i32 page(Core core, Page page) {
  page.render("<button id=\"go\">go</button><p id=\"out\"></p>").wait();
  page.on("button", "click").wait();
  i32 clicks = 0;                                  // state, in a local
  while (true) {
    Event e = page.nextEvent().wait();
    clicks = clicks + 1;
    page.setText("out", itoa(clicks)).wait();
  }
}
```

**An event is just another ticket.** `nextEvent` parks the worker exactly as `recv` parks it on
a socket, while the page's own thread — the host — stays free to run the real event loop and
queue what arrives. Three things follow, and they are the reason for the shape:

- **It is a loop, so state lives in locals.** Callbacks would need somewhere to put `clicks`,
  and wac has no mutable globals; the alternative is threading a state struct through every
  handler, which is the service shape and is heavier than this needs to be.
- **`waitAny` composes over it.** A click *or* a five-second deadline is
  `core.waitAny(i32[](e.id, file.id), -1)` — a click *or* a dropped file, one call. That is
  the thing callbacks make hard.
- **The application decides when it is over.** Returning from `page` ends it and the launcher
  prints the exit line; the document stays as the program left it.

Beyond drawing and events there are three more: `drawPixels(id, w, h, rgba)` blits a buffer wac
filled into a `<canvas>`, and `nextFile`/`offerDownload` carry bytes between the user and the
program. `example/pixels.wac` is all three at once — a Mandelbrot set recomputed on every zoom,
the escape count under the pointer, and a dropped file handed straight back.

**One coarse capability is the whole raster story**, and deliberately so. A 2D context would be
dozens of calls, each a round trip across a thread boundary to touch an object this side cannot
hold. A buffer is one call, and wac is good at filling a buffer — a plot, a fractal, a decoded
image and a sprite are all a loop over bytes, compiled.

**There is no "open a file dialog".** A browser opens one only during a real user gesture, and
by the time a request has crossed to the worker and back, that gesture is over — the capability
would work when tested by hand and fail in the field. So the user does the handing: an
`<input type="file">` in the application's own markup, or a drop anywhere on it, and `nextFile`
answers with the bytes and the name.

The operations are coarse, for the reason at the top of `platform.wac`. `render` replaces the
application root in one call; `setText` and `setValue` are for the targeted updates that would
otherwise mean re-rendering to change a word. There is no `querySelector`-shaped surface — every
property poke would be a round trip across a thread boundary, to reach an object this side
cannot hold. `setText` is `textContent`, so a value carrying `<script>` lands as those
characters; `render` is the one that parses, and that difference is where an injection bug in a
page like this would come from.

Subscriptions are **delegated from the document**, so they survive a `render` that replaces the
elements they were asked about. Attaching to the elements themselves would break on the next
redraw, and the symptom — the first click works and the second does not — sends you looking in
the wrong place.

`example/counter.wac` is the small one and `example/pixels.wac` is the raster one.
`packages/box/example/term.wac` is `packages/sh` with a keyboard in front of it — a real shell
in a tab, with pipelines, loops and redirection into OPFS that survives a reload; what it cannot
run is `$WACPATH` programs, since those need `spawn` and `spawn` is Deno-only.

And `packages/box/example/hash.wac` is the one worth seeing: type into a box and watch SHA-256 from `packages/crypto` and DEFLATE from
`packages/gzip` keep up, both written for a command line and neither changed for this. 18KB of
text hashes and compresses to 131 bytes in about a millisecond, on a worker, so the typing stays
smooth. No JavaScript was written by anybody.

**`rename` is the promise a page cannot keep.** OPFS has no rename, so it is a copy and a
delete. Atomicity is the entire reason `rename` exists — `cp` and `sponge` write beside
their target and move it into place — so those applets are genuinely weaker in a browser
than on a filesystem, and there is nothing this side can do about it.

`SharedArrayBuffer` needs the page cross-origin isolated, so the launcher checks
`crossOriginIsolated` first and names the two headers rather than letting `newBridge`
throw a bare TypeError. `box httpd -x` sends them, which makes the whole loop wac: a wac
server delivering a wac application to a browser.

**Run in a real browser**, on Chromium 151 — `test/browser_live.test.ts`, which builds the
page, serves it with the two headers, and drives it with Playwright. It is *ignored* unless a
browser is installed, so the suite stays zero-dependency and offline by default; the file says
how to install one in three commands, and the skip costs 3ms and no network.

It was worth the trouble immediately. `readDir(".")` had passed against the in-memory OPFS for
a week and answered **"not a directory"** in Chromium: OPFS has no `.` entry, and the double's
path handling had been written from the same assumption as the code it was checking, so it
agreed with the bug. Deno and Node both answer `.` with the listing, so portable code asked the
obvious question and silently got nothing. Fixed, and `browser.test.ts` now has the case —
which fails against the old code, in the double as well.

The argument that the rest was safe held up: `SharedArrayBuffer` under genuine cross-origin
isolation, `Atomics.wait` on a real `Worker`, and the blob-URL worker all worked first time,
because they are shared verbatim with the targets that were already tested. It was the
browser-specific part that was wrong, which is the part a double cannot check.

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

- **`spawn` on Node.** Deno only. `host/children.ts` takes `startWorld` as a parameter
  precisely so Node can follow without editing it, and nobody has written that side.
  Browser is a separate question: `Worker` exists there, but a page has no filesystem to
  read a bundle from, so what `spawn` should even take is undecided.
- **A service shape.** `main(Core, Cli) -> i32` is the CLI application and
  `page(Core, Cli, Page) -> i32` is the interactive one; both run once and return. A
  long-running *server* wants `onBytes(this, u8[]) -> Served`, which `packages/server` already
  defines and drives from its own host; folding it into the launcher is the next step.
- **A page has no network at all.** No TCP, which is structural — `fetch` is not a socket, so
  `connect` is refused rather than approximated — but no `fetch` capability either, which is
  merely unwritten. It would be request/response rather than a stream, so it revives none of
  `http`, `tls`, `tor` or `ssh` in a page; the browser does that layer itself.
- **`Event` carries no modifiers and no pointer button.** Enough for clicks, typing and
  `pointermove`, so a canvas application can draw; not enough to tell a left-drag from a
  right-click, or to read Shift. The first thing anyone building on `drawPixels` will want.
- **An OS process.** Deliberately not here, and not planned — see wac-mono issue 0015,
  closed `wontfix`. Running arbitrary host programs is a non-goal: it makes every grant
  transitive, and the interesting artefact turned out to be the other one, where a child is
  a wac program with grants its parent chose.

Two things this section used to list are done: the browser provider (`--target browser`,
and it now runs in one, see `test/browser_live.test.ts`) and outbound network
(`connect`/`listen`/`accept`).
