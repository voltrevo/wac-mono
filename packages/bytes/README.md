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
- **`take()` returns the buffer's own storage** when the buffer is exactly full,
  so it must not be used afterwards. `bytes()` always copies, for callers that
  keep appending.

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
