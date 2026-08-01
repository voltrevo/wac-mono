# stream

Run a wac transform as a `ReadableStream`/`WritableStream` pair, so it consumes input as it arrives
instead of taking the whole thing at once.

```ts
import { wacTransformStream } from "./host/bridge.ts";

const out = Deno.stdin.readable.pipeThrough(
  wacTransformStream({ modulePath: "packages/stream/src/transform.wac", entry: "upperCase" }),
);
```

## The problem this solves

wac has no way to suspend. A transform that wants its input in pieces therefore has to be written as
a resumable state machine — every loop position, every partially-read unit and every phase turned
into a field it can be re-entered from. For a UTF-8 case mapper that is mildly annoying; for
DEFLATE it is block loop, symbol loop, extra bits and copy loop all rewritten — which is what
[`issues/0006`](../../issues/closed/0006-streaming-gzip-is-now-representable.md) was about, and what
this avoided.

The observation here is that **the transform does not have to be the thing that suspends.** If the
host blocks instead, wac can stay an ordinary nested loop:

```wac
export i32 upperCase(fn[u8[]()] read, fn[bool(u8[])] write) {
  while (true) {
    u8[] chunk = read();          // <- blocks in the host until bytes exist
    if (chunk.len() == 0) { break; }
    ...
  }
}
```

`src/transform.wac` is exactly that — a `while` loop with a few bytes of held state for a scalar cut
in half by a chunk boundary, and no idea that anything ever waited.

## How

The transform runs on a worker, because a worker is allowed to block. `read()` calls
`Atomics.wait`, which parks the thread *with the wasm frame still on its stack*, and the producer on
the main thread wakes it. The main thread never blocks: it uses `Atomics.waitAsync`.

Two ring buffers in a `SharedArrayBuffer` carry the bytes, described in `host/layout.ts`. Each is a
pair of monotonic counters — bytes ever written, bytes ever consumed — so `head - tail` is what is
available and there is no empty-versus-full ambiguity.

Back-pressure runs both ways, which is why this is a readable/writable pair rather than a
`TransformStream`. A transformer is driven entirely by its writer: `transform()` is its only chance
to emit, so output appears only when input is pushed, and a consumer that stops reading is never
noticed. Here `pull` is the consumer asking, so a consumer that stops reading fills the output ring,
which blocks the transform, which fills the input ring, which stops the writer. There is a test that
holds the reader still and checks the writer stalls within a few rings rather than absorbing the lot.

Nothing polls, in either direction.

## What it costs

- **A worker and a `SharedArrayBuffer` per stream.** Fine for a handful of streams, not for
  thousands. Deno gives `SharedArrayBuffer` without ceremony; a browser gives it only under
  cross-origin isolation.
- **`runWhole` for anywhere it cannot run.** Same wac code, one call, no worker — correct, but
  `O(input)` memory and no incremental output. The tests use it as their oracle, which is what makes
  the central property meaningful: for every input and every way of cutting it into chunks, the
  streamed bytes equal the whole-input bytes. If that holds, where the chunks fall cannot matter.
- **16 callbacks per signature, for the life of the module.** Bindgen registers each distinct
  function *identity* in a fixed table and never releases a slot, so a fresh closure per call dies on
  the seventeenth with a `RangeError`. Both callers here hold one stable pair of functions and mutate
  state behind them rather than closing over it. Anyone writing a new host for a wac callback should
  do the same.

## Status

`harness/wacBind.ts` currently patches two conversion helpers into the generated bindings that
bindgen calls but does not emit — see [`wac` issue 0054](../../../wac/issues/open/). Without it, any
callback with an array in its signature throws `ReferenceError` on first use. **Delete
`withArrayHelpers` when 0054 is fixed**; it is written to be inert once the definitions arrive.

The bridge is generic: any export shaped `i32 f(fn[u8[]()] read, fn[bool(u8[])] write)` can be
streamed through it. [`packages/gzip`](../gzip/README.md) now exports `gunzipStream` in exactly that
shape, so a gzip file becomes a `DecompressionStream` by naming a different module:

```ts
wacTransformStream({ modulePath: "packages/gzip/src/inflate.wac", entry: "gunzipStream" })
```

Compression is not streamed. DEFLATE's encoder picks its Huffman tables from a whole block, so the
unit there is the block rather than the chunk — a different problem from this one.

## Layout

| path | what |
|---|---|
| `src/transform.wac` | the transforms: `passthrough`, and `upperCase` over UTF-8 |
| `host/layout.ts` | the shared-memory layout, in one place so both threads agree |
| `host/worker.ts` | where the transform runs and where blocking is allowed |
| `host/bridge.ts` | `wacTransformStream`, and `runWhole` for the non-worker case |
| `cov.ts` | `deno task coverage:stream` — 100% of the wac branches |
