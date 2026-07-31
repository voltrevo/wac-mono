# 0002 — `coverage` and `mutate` only see gzip, but report as if repo-wide

- **Status:** open
- **Reported by:** agent-b
- **Date:** 2026-07-31
- **Kind:** bug
- **Symptom:** wrong answer, no error

`deno task coverage` prints a table headed `all` with a single percentage. It looks
like the repo's branch coverage. It is gzip's, plus whatever gzip happens to reach.

```
| file | points | covered | % |
| packages/bytes/src/buf.wac      |  31 |  21 |  67.7 |
| packages/gzip/src/bitwriter.wac |   8 |   8 | 100.0 |
| packages/gzip/src/crc32.wac     |  16 |  16 | 100.0 |
| packages/gzip/src/deflate.wac   |  82 |  82 | 100.0 |
| packages/gzip/src/gzip.wac      |  21 |  21 | 100.0 |
| packages/gzip/src/huffman.wac   |  34 |  34 | 100.0 |
| packages/gzip/src/inflate.wac   |  92 |  76 |  82.6 |
| packages/gzip/src/tables.wac    |   7 |   7 | 100.0 |
| **all**                         | 291 | 265 |  91.1 |
```

Absent: `json`, `fmt`, `wactest`, `crypto`, `wacc` — five of the seven packages, and
the majority of the repo's wac source.

`tools/mutate.ts` has the same shape: every mutation it applies is in
`packages/gzip/src/crc32.wac`.

## Reproduction

```sh
deno task coverage        # eight files, all gzip or reached from it
grep -c 'packages/gzip' tools/coverage.ts
grep -c 'packages/crc32\|packages/gzip' tools/mutate.ts
```

`tools/coverage.ts` hardcodes its entry points — `packages/gzip/src/gzip.wac`,
`inflate.wac`, `crc32.wac` — and drives them with gzip's own exercises, including
`buildCorpus` from gzip's fuzz corpus. There is no discovery step.

Expected: either every package, or a report that says which packages it covered.
Actual: a figure labelled `all` that silently omits most of them.

## Notes

The misleading part is not the omission, it is the one line that *is* included.
`packages/bytes/src/buf.wac` shows 67.7% because it appears only through gzip's
imports — the branches json exercises (`pushCodepoint`, `toStr`, `reserveFor`'s bulk
path) never run. Someone reading that table would reasonably conclude the shared byte
buffer is under-tested, and act on it. It has its own test file with twelve cases.

So the number is worse than absent: it is wrong in a direction that invites work
nobody needs.

Both tools were written when gzip was the only package, which is why they look like
this — no criticism intended, and gzip's own coverage discipline is why the tool
exists at all.

Two options, and the cheap one may be enough:

1. **Say what it covered.** Retitle `all` to name the entry points, and note in the
   root README that coverage is per-package rather than repo-wide. Costs nothing and
   removes the false reading.
2. **Generalise it.** Each package declares its instrumented entry points and the
   exercise that drives them — probably a convention like `packages/*/cov.ts` — and
   the tool discovers them. More work, and it needs each package's author to supply
   the exercise, since coverage without one measures nothing.

Filed rather than fixed because `tools/` is shared and generalising it changes an
interface other packages would have to meet.
