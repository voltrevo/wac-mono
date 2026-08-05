# 0065 — a spawned program's arguments are not byte-exact

- **Status:** closed
- **Claimed by:** agent-a (2026-08-05)
- **Reported by:** agent-a
- **Date:** 2026-08-04
- **Kind:** bug
- **Symptom:** wrong answer

## Reproduction

Any spawned program, given an argument whose bytes are not valid UTF-8:

```sh
wacsh -c "cat $(printf '\xff\xfe')"
```

Expected, which is what bash and GNU `cat` do — the bytes as given:

```
cat: \xff\xfe: No such file or directory
```

Actual: the two bytes arrive as two U+FFFD replacement characters (`ef bf bd` twice), so the diagnostic
names a file nobody asked about — and a program using the argument as a *path* would open the wrong one,
or fail to open one that exists.

Reachable today through `packages/box`'s browser terminal, which spawns sixty applets, and through
`$WACPATH`. It is *not* reachable through `packages/sh`'s own twelve, because they are called in process
— and turning that on is what found this: `packages/sh/src/sh.wac` holds the one line back with a
comment naming this issue.

## Notes

The wire format is the problem and it is one place. `provider.ts` packs `spawn`'s arguments as a
length-prefixed NUL-joined block; `children.ts` unpacks it with a `TextDecoder`:

```ts
const joined = dec.decode(p.subarray(argsAt + 4, argsAt + 4 + argsLen));
args: joined.length === 0 ? [] : joined.split(NUL),
```

`TextDecoder` replaces anything that is not valid UTF-8, and the child's world re-encodes with a
`TextEncoder`, so the round trip is lossy in the middle. wac strings are byte arrays — the compiler does
not validate them — so both *ends* are byte-exact and only the host's own hop is not.

What it takes: carry the arguments as bytes rather than as text, from `unpackSpawn`/`unpackSpawnSelf`
through `spawnChild` into the child world's `args`, and let the `ARG` capability send those bytes
through unchanged. The world option is `string[]` today and is passed by every host and several tests,
so this is either a union (`(string | Uint8Array)[]`) or a conversion at the world's edge.

A NUL *separator* is safe to keep: an argument cannot contain one on any operating system this targets.
The bug is entirely the decode.

Same shape as the fault-category work in
[0062](../closed/0062-a-read-failure-has-no-fault-category-so-nine-programs-print-the-hosts-wording.md):
both ends were fine and the host's hop was where the information went missing.

## It is not the wire format, 2026-08-05 (agent-a)

The notes above blamed `children.ts`'s `TextDecoder`. That is one of three lossy hops, and fixing it
alone would change nothing. Measured while closing
[0066](../closed/0066-a-spawned-child-does-not-get-what-the-shell-has-left-of-its-input.md):

1. **wac to JS**, in the compiler's own glue. `wacBindgen.ts` emits
   `_stringFromWasm`, which is `new TextDecoder().decode(bytes)` — so a wac string containing
   `\xff` is already two replacement characters *before* it reaches `provider.ts`.
2. **The wire format**, as the notes said: `str`/`unstr` in `host/call.ts` are `TextEncoder`/
   `TextDecoder`, and `children.ts` decodes the NUL-joined block the same way.
3. **JS back to wac**: `_stringToWasm` is `new TextEncoder().encode(s)`, which cannot emit a lone
   surrogate, so the child's `arg` reply is normalised again on the way in.

So every `string` crossing the capability boundary is UTF-8-normalised in both directions, and this is
not about `spawn` at all — it is about what a `string` *means* at that boundary. A path, an environment
value and an argument are all bytes on the systems this targets.

Two ways to fix it, and the second is the smaller diff at the call sites:

**(A) Make the boundary byte-exact in the compiler.** Replace the `TextDecoder`/`TextEncoder` pair in
`wacBindgen.ts` with a surrogate-escape codec: invalid bytes decode to lone surrogates `U+DC80..DCFF`
and encode back to the same bytes, which is what Python's `surrogateescape` does and what a filesystem
API in a garbage-collected language usually ends up doing. Valid text is untouched, so every host that
treats one of these strings as text keeps working. wac's own `string.fromCodepoint` traps on a lone
surrogate, so the escaped form never exists *inside* wac — only in the JS half, which is where the
bytes need somewhere to live. Roughly forty lines of codec plus tests in `../wac`, and it fixes paths and
environment values at the same time.

**(B) Make the capabilities carry bytes.** `spawn(string source, u8[][] args, …)`, and `arg` answering
`Pending<u8[]>` with a wac-side `argText` helper for the callers that want text. No compiler change, but
`cli.arg(…)` has about fifty call sites across eight packages.

(A) is the one to do: the loss is at the boundary, not in the signature, and (B) leaves paths and `env`
lossy while making every applet spell out a conversion. It does mean a change in the compiler that every
package depends on, so it wants its own tick and wac's own suite green first.

Note also what is *not* broken: in-process argv is exact, because the bytes never leave wac —
`printf '\xff' | cat` and `cat $(printf '\xff\xfe')` are right today with the shell's programs called
rather than spawned. The Deno host cannot receive non-UTF-8 argv from the operating system at all
(`Deno.args` is already normalised), so this is about arguments a wac *parent* constructs.

## Decided, 2026-08-05 — the signature is the flaw, not the codec

Put to the operator as a choice between a surrogate-escape codec in `wacBindgen.ts` and turning the
capabilities into bytes. Their answer, and it is the right one: *bindgen should not be involved; this is a
design flaw rather than a conversion to solve.*

`readFile(string path)`, `arg(i) -> string` and `spawn(source, string[] args)` say **text** where the thing
is **bytes** — a path, an argument, a directory entry, an environment value. Because the type says text, a
conversion has to exist, and every conversion between bytes and text loses in one direction. A clever
codec would only make the lie survive longer.

**The split to build:**

| bytes | text |
|---|---|
| `arg`, `env` | `log`, `warn` — a person reads them |
| every path parameter, and `readDir`'s answers | `spawn`'s source, which really is JavaScript |
| `spawn`/`spawnSelf` argv | `Change.message`, `FileResult.error` — the host's own words |
| | socket addresses |

Then nothing needs a codec, because nothing converts.

Two consequences worth stating up front:

- **It fixes [0061](0061-sh-applets-return-all-their-output-at-once-so-a-large-stage-dies.md)'s second
  half.** Spawn's arguments go parent-wac → host-as-courier → child-wac and never become text, so there is
  no loss to escape. That is the case that blocks `Shell.externalSpawnable`.
- **The one unavoidable loss becomes a refusal.** `Deno.readFile` takes a JS string, so a path whose bytes
  are not valid UTF-8 cannot reach that host — but with bytes in the signature the *host* is what must
  decode, and it can answer "not representable on this host" as a fault rather than silently opening the
  wrong file. One named place per host instead of a mangling in the middle. On a `packages/fs` mount, where
  no host API is involved, byte-exactness is real, which `fs/test/wac/fs_test.wac` already pins.

**Rejected: a surrogate-escape codec in the compiler** (invalid bytes as lone surrogates `U+DC80..DCFF`,
encoded back exactly). It would have cost ~40 lines and no call-site churn, and it was the wrong shape for
the reason above. Recorded so the next reader does not re-propose it.

**Cost:** about fifty call sites across eight packages; `cli.arg(0).wait()` becomes
`string.fromBytes(cli.arg(0).wait())` wherever a program wants text. A schedule, not a veto.

**Where to start:** `spawn`/`spawnSelf`'s argv and `arg`/`env`, which is what 0061 needs and touches the
fewest callers. Paths are the larger half and can follow in their own commit.

## Half done, 2026-08-05 (agent-a)

**Arguments and the environment are bytes.** The operator's answer settled the shape — bindgen should
not be involved, the signature was the flaw — so `arg`, `env` and the argv of `spawn`/`spawnSelf` now
carry `u8[]` end to end, and the spawn wire format carries a count and length-prefixed arguments
instead of one NUL-joined blob of text. Names and arguments are bytes; messages and source are text.

That unblocked [0061](../closed/0061-sh-applets-return-all-their-output-at-once-so-a-large-stage-dies.md):
`cat $(printf '\xff\xfe')` names the file it was given, and the shell spawns its own programs now.

**What is left is paths**, which is the larger half. `readFile`, `writeFile`, `stat`, `readDir`,
`mkdir`, `remove`, `rename` and `openOutput` all take a `string`, and a name that is not valid UTF-8
cannot survive one — while `readDir` hands such names back happily, so a shell can list a file it
cannot then open. The rule to hold to: the host decodes a path only where the API it calls demands
text, and where a name cannot be represented it reports a fault rather than approximating it.
`packages/fs` already pins the property on a memory mount, where no host API is involved, which makes
it the place to test the rule before the hosts implement it.

## The second half, and it is not what this issue assumed (agent-a, 2026-08-05)

The paths half is **closed as not-fixable-here**, with the gap named instead. That is a different answer
from the one above, and the measurement is why.

I had written that the rule to hold to is "the host decodes a path only where the API it calls demands
text, and where a name cannot be represented it reports a fault". The second clause is right. The first
does not apply, because on Deno *every* path API demands text and there is no alternative:

```
$ ls -b .                       # created with python: b"bad-\xff-name"
bad-\377-name
$ deno … readDir(".")           # what the world receives
"bad-\ufffd-name"  [62 61 64 2d ef bf bd 2d 6e 61 6d 65]  stat FAILS: NotFound
```

`Deno.readDir` replaces the invalid byte with U+FFFD before anything of ours sees it, and `Deno.stat` of
the name it just handed back fails. So the file is unnameable from this runtime, and **changing our
signatures from `string` to `u8[]` would not have helped** — wac strings are byte arrays already, so a name
survives the bridge; it does not survive the runtime's own API. The churn this issue implied for eight
capabilities and every caller would have bought nothing on the host we actually run.

What was wrong was the *sentence*. A file the caller has just seen in `ls` reported as "No such file or
directory" reads as their mistake. So:

- **`FAULT_NOT_REPRESENTABLE`** joins the five categories, in `platform.wac` and `host/faults.ts`, with the
  reasoning for why it is distinct from absence written where the constant is.
- **`pathFailure(e, path)`** refines a `NotFound` for a path containing U+FFFD into that category, and the
  Deno host wraps every path-taking operation in it — `readFile`, `writeFile`, `readDir`, `mkdir`, `remove`,
  `rename`, `openInput`, `openOutput`. It travels as a thrown `Faulted`, which every reply path already
  respects, so no plumbing changed.
- **`sh` says it**: `cat`, `wc`, `rm` and the rest print `cannot be named on this host`, and `rm -f` does
  *not* swallow it, because a file that is still there afterwards is not absent.
- Tested twice: the refinement in `packages/platform/test/unnameable.test.ts`, and what a person sees in
  `packages/sh/test/unnameable.test.ts`. Neither is a differential case, and that is the point — bash
  handles these names perfectly, so comparing against it would only restate the gap. `packages/sh/README.md`
  records the divergence.

**What a future host can do.** Node's `fs` accepts a `Buffer` path, so the Node host could be byte-exact and
would simply never raise this category. That is the shape of the remaining work and it is a *host*
capability question rather than a signature question — which is the correction this issue needed.

`stat` is the one operation still lying: it answers a struct with no fault field, so an unnameable name
reads as "does not exist". Left alone deliberately — giving `Stat` a fault means changing its shape and
every caller, and the callers that matter (`test -e`, `ls`) would then have to decide what to *do* about a
name they cannot express. That is a real design question and not one to answer in passing.

## Closed, 2026-08-05 (agent-a): `stat` answers now, and the phrase table is one copy

The section above left `stat` as "the one operation still lying", on the grounds that giving `Stat` a fault
means changing its shape and every caller, and that the callers would then have to decide what to *do*.
Both are true. Neither is a reason — "it would change every caller" is a schedule.

**`Stat` carries `i32 fault`, and the semantics are narrow on purpose.**

- **Absence is an answer, not a fault.** A path with nothing at it gives `exists = false` with
  `FAULT_NONE`, because "there is nothing here" is what `stat` was asked. `ENOTDIR` is the same: bash says
  `test -e f/g` where `f` is a file is *false*, not an error, so a fault there would put every shell of
  ours at odds with the oracle. `rm -f` and every "does it exist" check depend on this staying true.
- **Only an unreachable question is a fault**: `FAULT_NOT_REPRESENTABLE` for a name this host cannot
  express, and `FAULT_DENIED` for a world with no read capability. That second one was the same lie in
  another costume — a program with no read grant was told "does not exist", and could not tell that from a
  file it was not allowed to look at.
- `Stat.answered()` reads better than `st.fault == FAULT_NONE()` at a call site, and the field's doc says
  plainly: **check `fault` before trusting `exists`**.

**The wire.** `STAT_BYTES`/`STAT_FAULT` live in `host/faults.ts` because three hosts answer this operation
and `provider.ts` reads what they wrote; a field appended in two of three is a silent disagreement about a
format, which is how `spawn`'s argv was wrong for a week. `statFault(e, path)` is the one mapper, so Deno,
Node and the browser cannot drift on which failures are faults.

**What the callers do with it**, which was the part this issue said should not be answered in passing:

- **`test -e/-f/-s`** on a name that cannot be examined now exits **2 with a diagnostic** instead of
  answering `false`. That is the shape `test` already used for an operator it has not implemented, and the
  difference matters: a script acts on `false`.
- **`ls`** says `cannot access 'x': cannot be named on this host` rather than GNU's "No such file or
  directory" for a name `readDir` has just handed it. A genuinely missing operand keeps GNU's sentence
  exactly, because the corpus compares that line.
- **`box ls`** loses its comment claiming the application "cannot tell, by design" — it can now — and
  **`box stat`** stops saying `not found` when what happened was something else.

**And the phrase list is one copy instead of four.** `sh` had one for a `Change` and another for a
`FileResult`, `box` had a third, and `statReason` was about to be a fourth. They had already drifted: the
`box` one had no phrase for `FAULT_NOT_REPRESENTABLE`, so it printed the host's English for the one
category that exists to prevent exactly that. `faultWords(i32)` is in `platform.wac` beside the fault
numbers — a fault number is meaningless without them — and each caller is now the table plus its own
fallback for the message a struct carries.

Verified: the 614-script corpus, the 57-script two-backings comparison, all of `packages/platform`, and
`packages/box` — 79 + 28 passing, with four new cases in `packages/sh/test/unnameable.test.ts` for what
`stat` used to get wrong and two in `packages/platform/test/unnameable.test.ts` for the mapper's narrowness
and the wire layout.

**Not implemented, and said plainly rather than approximated:** a byte-exact Node host. Node's `fs` accepts
a `Buffer` path, so a host built on it would never raise `FAULT_NOT_REPRESENTABLE` at all — but our Node
host goes through the same `string` bridge as the others today, and making it byte-exact means giving the
bridge a bytes-shaped path for one host and not the rest. Nobody needs that yet; when someone does, this
issue's measurements are the starting point.
