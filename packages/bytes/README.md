# bytes

`Buf` — a growable byte buffer.

```wac
import { Buf } from "../../bytes/src/buf.wac";

Buf b = Buf.create();
b.push('h');
b.pushAll(u8[]('i'));
string s = b.toStr();     // "hi"
```

## Why it is a package

`gzip` and `json` had each written this type, independently and almost
identically. wac has no generics, so a container cannot be written once over its
element type — but it can be written once over `u8`, and that is what this is.

The merge was not free of consequence, in a good way: `gzip`'s `pushBytes` had
appended through `push` one byte at a time, paying a capacity check and a
bounds-checked store per byte. The shared version reserves once and writes
directly, which took `stored` throughput from ~155 MB/s to ~215 MB/s. Two
implementations of the same thing means one of them is slower and nobody notices.

## Shape

Three details are load-bearing rather than stylistic, and changing them will show
up in `deno task bench`:

- **`len` is a public field, not a method.** It is read once per pushed byte in
  gzip's inner loops.
- **`reserve()` takes no argument** and only makes room for one byte, keeping the
  common `push` path to a single comparison. Bulk appends use `reserveFor(n)` so
  they grow once instead of doubling repeatedly.
- **`take()` returns the buffer's own storage** when the buffer is exactly full, and
  empties the buffer to enforce it. Continuing to use a taken `Buf` is safe — pushes
  land in fresh storage rather than writing through the array it handed away.
  `bytes()` always copies, for callers that keep appending.

## API

| | |
|---|---|
| `create()` / `withCapacity(n)` | `withCapacity` skips the doubling when the final size is known, and lets `take()` avoid its copy |
| `len` | field, byte count |
| `push(v)` | truncates to 8 bits, as the array store does |
| `pushBytes(src, start, count)` / `pushAll(src)` | bulk, one growth |
| `pushU16(v)` / `pushU32(v)` | little-endian, for gzip's headers |
| `pushCodepoint(cp)` | UTF-8; surrogate pairs must already be resolved |
| `get(i)` | bounds-checked, traps |
| `bytes()` | exact-length copy |
| `take()` | hands over the storage when exactly full, else copies |
| `toStr()` | contents as a `string`, taken to be UTF-8 |

Bytes are `u8`, so a byte with the high bit set reads back as 128–255 rather than
negative. That distinction is why `i8[]` is the wrong type for byte data.

## Coverage

`deno task coverage:bytes` reports branch coverage, driven by `cov.ts` in this
package. Currently 100% — `buf.wac`.

Coverage needs an exercise, and an exercise only measures the code it drives, so each
package supplies its own; `harness/wacCoverage.ts` is the shared half. The repo-level
`deno task coverage` covers gzip only, which is [issues/0002](../../issues/open/0002-coverage-and-mutate-only-see-gzip.md).

The hazard to know about: `cov.ts` is a second workload written by hand, so it drifts
from the test suite it is meant to measure. Twice now it has reported a branch as
uncovered that the tests do cover, and once the reverse. When it disagrees with the
suite, the suite is right and `cov.ts` needs the input adding.

## `Read` moved to `core`

It used to be `src/read.wac`, here rather than in `packages/platform`, because of who has to name
it: the streaming transforms in `gzip` and `stream` take their source as a funcref and `platform`
hands `cli.readChunk` to them directly, so a capability world and two pure algorithm packages all
had to name one type — and `bytes` was the only package below all of them.

That reasoning still holds and now points somewhere else. wac has no closures, so two declarations
of `Read` can never be converted into each other; being below everything in *this* repo is not
enough once `platform` is a repo of its own. So `Read` is in `core`, the module the compiler ships,
which is the only place with one identity everywhere:

```wac
import { Read } from core;
```

Nothing here re-exports it — a re-export would leave two spellings, and someone would write new code
against the old one. See wac's `design/0001` for the admission rule, which is narrow: a type belongs
in `core` only if it must cross a repository boundary through a funcref signature.
