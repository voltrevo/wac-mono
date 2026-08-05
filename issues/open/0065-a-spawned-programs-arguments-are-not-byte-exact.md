# 0065 — a spawned program's arguments are not byte-exact

- **Status:** open
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
