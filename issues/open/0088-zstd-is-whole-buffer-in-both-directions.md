# 0088 — zstd is whole-buffer in both directions, and gzip is not

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-c
- **Date:** 2026-08-06
- **Kind:** missing feature
- **Symptom:** not implemented

`packages/gzip` streams: `gunzipStream(read, write)` decodes as bytes arrive, and
[0006](../closed/0006-streaming-gzip-is-now-representable.md) records what it took.
`packages/zstd` does not. Its whole surface is

```wac
export u8[] compress(u8[] data);
export u8[] decompress(u8[] src);
```

so every user holds the entire input *and* the entire output in memory at once. `box unzstd` on a
file larger than the heap fails where `box gunzip` on the same-sized file does not, and
`packages/stream`'s bridge — which is generic — can drive one codec and not the other.

## The shape

The same as gzip's, deliberately:

```wac
export i32 zstdStream(fn[Read()] read, fn[bool(u8[])] write);
export i32 unzstdStream(fn[Read()] read, fn[bool(u8[])] write);
```

**Not** an incremental `push`/`finish` object. That was 0006's original proposal and the repo went the
other way for a reason worth repeating, because it is the first thing anybody designing this will
reach for:

> wac has no way to suspend. A transform that wants its input in pieces therefore has to be written
> as a resumable state machine — every loop position, every partially-read unit and every phase
> turned into a field it can be re-entered from. For a UTF-8 case mapper that is mildly annoying; for
> DEFLATE it is block loop, symbol loop, extra bits and copy loop all rewritten … **The transform does
> not have to be the thing that suspends.** If the host blocks instead, wac can stay an ordinary
> nested loop.
>
> — `packages/stream/README.md`

So the transform keeps its ordinary loops and the *host* blocks in `read`. `packages/stream`'s bridge
already does this and is generic over the entry point, so a `zstdStream` of this shape needs nothing
new from it.

`Read` rather than `u8[]` for the same reason gzip uses it: an empty array means both "finished" and
"failed", every filter in this repo treated the second as the first, and `gzipStream` produced a
*valid* archive of half its input with a CRC to match. `Read` is in `core`, the module the compiler
ships — `import { Read } from core;` — so both ends of a stream name one type.

## What is actually hard here

Decoding first, and it is not symmetric with gzip:

- **the window.** zstd's back-references reach up to the window size declared in the frame header,
  which can be far larger than DEFLATE's fixed 32 KiB. Whatever holds the recent output has to be
  sized from the header rather than fixed, and the frame may also declare a *single-segment* size.
- **the block is the unit, not the chunk.** A zstd block carries its own literals section and FSE
  tables; nothing can be decoded until the block is complete. So the reader has to accumulate to a
  block boundary, which means the streaming unit is bounded by the block size rather than by what
  the caller happened to hand over.
- **`decodeAndExecute` and `decodeCompressed` already take a `Buf out`**, so the seam for sending
  output away as it is produced is roughly where gzip's `Window` went. Sharing one copy of the format
  between the buffered and streamed paths is the property to aim for — 0006's closing note says that
  is what made the gzip change worth having.

**Compression is the harder half and may be out of scope**, exactly as it was for gzip: 0006 closed
with "DEFLATE's encoder chooses its Huffman tables from a whole block, which makes the streaming unit
the block rather than the chunk". zstd is the same in kind and worse in degree, since its encoder also
picks FSE tables per block. Decoding alone would be a good landing point, and would say so.

## Done when

`unzstdStream` decodes byte-identically to `decompress` **for every way of cutting the input into
chunks**, including a split at every single byte, over the existing corpus — which is the property
0006 used for gzip rather than fixed vectors, and it is the one that finds the boundary bugs. Plus an
input large enough that a back-reference reaches across a window hand-over.

Then `box unzstd` uses it, so the applet stops holding the whole file.

## Notes

This also removes an asymmetry that has nothing to do with zstd: `packages/stream` claims to run "a
wac transform" as a stream pair, and today that means gzip and the two toy transforms in
`stream/src/transform.wac`. A second real codec is the evidence that the bridge is general rather than
shaped around one caller.
