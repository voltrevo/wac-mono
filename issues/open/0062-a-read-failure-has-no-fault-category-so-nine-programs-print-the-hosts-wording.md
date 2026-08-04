# 0062 — a read failure has no fault category, so nine programs print the host's wording

- **Status:** open
- **Reported by:** agent-a
- **Date:** 2026-08-04
- **Kind:** diagnostic
- **Symptom:** wrong answer

## Reproduction

```sh
wacsh -c 'wc -l missing'
```

Expected, which is GNU's:

```
wc: missing: No such file or directory
```

Actual:

```
wc: missing: No such file or directory (os error 2): readfile '/tmp/x/missing'
```

Same for `cat`, `head`, `tail`, `sort`, `uniq`, `rev`, `nl` and `grep` — every program in
`packages/sh/src/program.wac` that opens a file — and the text differs by runtime: Node says
`ENOENT: no such file or directory, open '…'` for the same fault.

## Notes

The *mutating* side of this was fixed in
[0014](../closed/0014-platform-has-no-way-to-write-bytes-to-standard-error.md)'s neighbourhood and in
the fault-category work: `Change` carries `fault`, `host/faults.ts` classifies an exception into
`FAULT_NOT_FOUND`/`DENIED`/`EXISTS`/`NOT_EMPTY`/`OTHER`, and `reasonOf` in `exec.wac` turns that back
into GNU's phrase — which is why `mkdir` and `rm` are compared against GNU's own stderr, word for
word, in `differential.test.ts`.

`FileResult` never got the same treatment:

```wac
export struct FileResult {
  bool ok;
  u8[] bytes;
  string error;     // the host's sentence, and nothing a program can branch on
}
```

So a program cannot tell "absent" from "denied" without reading English, and cannot phrase either the
way the tool it is standing in for does. The reads matter as much as the writes now that the operands
are honoured at all: before this week `wc -l missing` printed `0` and exited `0`, so the wording was
the least of it.

The work is a field, three hosts, and a phrase function:

1. `FileResult` gains `i32 fault`, set from `faultOf` in `host/faults.ts` — the same classifier the
   write path already uses, so there is nothing new to decide about what the categories are.
2. `deno.ts`, `node.ts` and `browser.ts` each pass it through their `readFile`. The browser one is the
   reason this is worth doing rather than papering over: OPFS throws `NotFoundError`, whose message is
   nothing like either runtime's.
3. `program.wac` phrases it, next to where `reasonOf` phrases the mutations.

`linkStat`/`stat` have the same shape and are worth the same look, though `Stat.exists` already
answers the only question anybody asks of them.

Filed rather than done because it crosses `packages/platform` and all three hosts, and every package
that reads a file sees the change.
