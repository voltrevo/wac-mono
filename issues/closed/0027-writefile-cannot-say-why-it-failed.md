# 0027 — `writeFile` and friends answer `bool`, so a failure cannot say why

- **Status:** closed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-a
- **Date:** 2026-08-03
- **Kind:** missing feature
- **Symptom:** wrong answer

`Cli.readFile` answers with a `FileResult` — `ok`, the bytes, and **the host's own message** —
and that message is why a failed read is diagnosable. Every *write* answers with a bare `bool`:

```wac
fn[Pending<bool>(string, u8[])] writeFile;
fn[Pending<bool>(string, bool)] mkdir;
fn[Pending<bool>(string, bool)] remove;
fn[Pending<bool>(string, string)] rename;
fn[Pending<string>(string)] openOutput;      // this one *does*: empty means opened
```

So "not granted", "no such directory", "read-only filesystem" and "no space left on device"
are all the same answer, and an application can only report what it was trying to do.

## Where it bit

Running `example/roundtrip.wac` as a browser page for the first time, it printed

```
roundtrip: cannot write roundtrip.txt
```

and I spent a while looking at the Origin Private File System code before realising I had built
the page without `--allow-write`. The host knew — `browser.ts` throws
`filesystem write not granted to this application` — and the boolean threw the sentence away
one layer below the program that would have printed it.

That is the *good* case, because I wrote both sides. An application that ships is going to say
"cannot write" to a user who has filled their disk.

## Shape

`openOutput` already shows the cheap version: a `string`, empty on success and the host's message
otherwise. It is ugly to read (`if (cli.writeFile(p, b).wait() != "")`) and it needs no new
struct, no bindgen class, and no change to the ticket machinery.

A `FileResult`-shaped answer is nicer to read and is a wider change: `Pending<Written>` with
`ok` and `error`, one new struct and one new `Pending<T>` monomorphisation.

Either way **every caller has to change**, which is why this is filed rather than done: `box`
alone writes in a dozen applets, and `sh`, `ssh` and `tor` all write too. It wants doing in one
commit, by someone who can run the whole suite after it, rather than piecemeal.

## Notes

Worth deciding at the same time whether `write` (standard output) joins them. It answers `bool`
for a different and defensible reason — a closed pipe is an answer, not a crash, and `head`
depends on that — so probably not.

`stat` needs nothing: absence is a legitimate answer there, and `exists` false says it.

## Closed, 2026-08-04 (agent-a)

`writeFile`, `mkdir`, `remove` and `rename` answer `Pending<string>` — empty on success, the host's message otherwise — which is the convention `openInput` and `openOutput` already used. No new struct, no new opcode for the four: the host already threw, and the worker-side `outcome` decoder already turned a thrown message into a string, so only the signature and one decoder call per capability changed.

The decision was the owner's: platform results carry a reason. What made it cheap was that the shape
already existed in this world — `openInput` has answered with a message since it was written, so this
is one convention applied consistently rather than a new one invented.
