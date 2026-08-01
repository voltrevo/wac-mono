# 0006 — streaming gzip is now representable, and was not before

- **Status:** open
- **Reported by:** agent-b
- **Date:** 2026-08-01
- **Kind:** missing feature
- **Symptom:** not implemented

`packages/gzip` is whole-buffer in both directions, and its README lists that as a known
limitation. It was not a choice: **a streaming API could not be expressed at all**, and the reason
has just gone away.

## Why it was impossible

wac has no module-level mutable state, and until `wac@8aea985` a struct could not cross the bindgen
boundary. Put together: there was nowhere for a stream's state to live between two calls from the
host. wac could not stash it, and the host could not hold it. Any API that needs "feed me the next
chunk" needs a value that survives the gap, and there was no such value.

Structs now cross as classes wrapping a reference, and `[§wac-bind-struct-5kqn2wj]` says the
reference *is* the value rather than a copy — so identity survives and a write through the wrapper
is visible to wac. That is exactly the property a stream object needs:

```ts
const z = Inflater.create();
z.push(chunk1);            // whatever it can decode so far
z.push(chunk2);
const rest = z.finish();
```

Static methods bind too, so `Inflater.create()` is callable from the host without a factory
function beside it.

## What is actually hard

The boundary was the blocker; it is not the work. Three things need doing, and the second is the
one that decides the shape:

**1. The bit reader has to suspend, not stop.** `BitReader.fill` today is

```wac
while (this.bitCount < need && this.pos < this.data.len()) { … }
```

Running out of input and having enough bits are the same exit. A streaming reader needs them
distinguished: "I need more input" is an outcome the caller acts on, not a state to read past. This
is the same three-outcome argument as `packages/http` — complete, failed, and *not yet decided* —
and folding the third into either of the others is the bug.

**2. The decoder has to become explicit state.** Resuming mid-symbol means the position inside a
Huffman decode, inside a block, inside a member, all has to be data rather than where-we-are-in-the-
loop. `packages/regex` had the same problem for the same reason — no closures, so a continuation
cannot be captured — and the answer there was a flat program with an explicit stack. Here it is
probably an explicit state enum plus saved counters. It is a rewrite of `inflateFrom`, not an
addition to it.

**3. The output window has to persist.** LZ77 back-references reach 32 KiB, so a streaming inflater
must keep the last 32 KiB *after* handing output to the caller. Today `out` is a `Buf` holding
everything, and the window is free because nothing is ever released.

The deflate side is the mirror: match-finding needs a lookahead buffer, and blocks have to be
flushed on a boundary the caller cannot see.

## The other new option, worth considering first

A `fn[void(u8[])]` parameter — a host callback — means output can be *pushed* rather than
accumulated, without any of the above:

```wac
export void inflateInto(u8[] data, fn[void(u8[])] sink)
```

That fixes unbounded output memory for a whole input that is already in hand, which is half the
problem and none of the difficulty. It does not help with input arriving in pieces. Worth doing
first if the motivation is memory rather than latency.

## What the no-compromises version looks like

Taking "no compromises" as: bounded memory (O(window), not O(input) or O(output)); suspend and
resume at *any* byte boundary; back-pressure in both directions; errors as values rather than
`trap`; an exact consumed-count so a caller can find a member's end inside a longer stream;
multi-member streams; and no copy per chunk.

Two designs reach different subsets, and both were checked against the current compiler rather
than reasoned about.

**A — wac pulls and pushes.** One call, two callbacks:

```wac
export i32 inflateStream(fn[u8[]()] read, fn[bool(u8[])] write)
```

Verified working: wac calls `read()` for the next chunk and `write()` for output, and a `bool`
return gives the sink back-pressure. **The decoder stays an ordinary nested loop — no state
machine at all**, because it never has to suspend. This meets everything on the list except one
thing, and that one thing is fatal for some callers: a wasm call cannot yield, so `read()` has to
supply input *synchronously*. Fine for a file, wrong for a socket.

**B — the host pushes into a held object.**

```wac
export struct Inflater { … Inflater create(); void push(this, u8[] chunk); }
```

Also verified: a struct crosses as a class, `create()` binds as a static, and state persists across
calls with identity intact — two wrappers over one reference are one object. This works with async
I/O because the host drives the loop. It meets the whole list. The cost is entirely in **2**:
resuming mid-symbol forces block loop, symbol loop, extra-bits and copy loop each into saved
fields.

So the no-compromises version is **B, and it is possible in current wac with nothing missing**.
What is missing is ergonomics, not expressiveness.

### What would actually change that — and it is closer than it looks

Coroutines would let B be *written* as A: the natural loop, suspended by the runtime rather than by
hand. That sounds like a language feature and a long wait. It is not.

**A wac module can already be suspended across an asynchronous host call, with no compiler change
at all.** Verified end-to-end: wrap the callback dispatcher the module imports in
`WebAssembly.Suspending`, call the export through `WebAssembly.promising`, and an ordinary wac loop
suspends on a real `await` without knowing it. Design A then works for a socket, not just a file,
and the state machine of design B is never written.

What is missing is only the *bindings* asking for it — filed as `wac/issues/0053`, where the
mechanics, the wrinkle (a dispatcher is per signature, not per parameter) and the caveats live.
Chief caveat: Deno has JSPI, Node 22 does not without a flag.

**So the recommendation is to wait before hand-writing a resumable decoder.** A state machine
written now is exactly the code that gets deleted when the bindings offer suspension, and design A
is both simpler to write and simpler to read.

**Zero copy is the one thing genuinely not expressible**, and it is not a wac oversight. Arrays
cross the boundary *by copy* — the spec says so — so every input chunk is copied in and every
output chunk out. wac cannot be handed a view of a host buffer, and cannot fill one, because a
write through a `u8[]` parameter is not visible to the caller. Fixing it needs either linear memory,
which wac deliberately does not have, or a borrowed view into a GC array, which wasm GC does not
offer. At gzip's throughput that copy is real but small, and it is the only item on the list that
no amount of work here removes.

**Errors as values needs nothing.** Enums are already there, and `inflate` trapping on a CRC
mismatch is a compromise the language is not forcing.

## Recommended design, without JSPI

JSPI is Deno-only today (`wac/issues/0053` has the measurements), so anything that must run on
Node or in a browser needs design B. B does **not** require resuming mid-symbol, and that is the
part worth getting right before starting — it is the difference between a six-state machine and a
thirty-state one.

**Two granularities of resumption, not one.** DEFLATE has bounded-size phases and one unbounded
phase, and they deserve different treatment:

- **Bounded phases — the gzip header, a block header, a dynamic Huffman table.** Each is at most a
  few hundred bytes. Treat them as *atomic*: if the retained bytes are not enough to finish one,
  keep them and return "need more", then **redo it from its start** next time. The table builder
  stays an ordinary function with no saved state at all. The cost is re-scanning a few hundred
  bytes when a chunk boundary lands badly, which is bounded and rare.
- **The unbounded phase — the symbol stream.** Commit at *symbol* boundaries. A literal, or a
  length/distance pair with its extra bits, is at most about 48 bits, so run the decode loop only
  while at least that many bits are buffered. Below the threshold, stop: the position is a symbol
  boundary and the state to save is small. This is what zlib's `inflate_fast` does and for the same
  reason.

Nothing then resumes mid-symbol, and the saved state is:

```wac
export struct Inflater {
  i32 mode;            // Header, BlockHeader, Stored, Tables, Symbols, Trailer, Done, Failed
  u32 bitBuf;          // partial byte
  i32 bitCount;
  u8[] pending;        // retained input, bounded by the largest bounded phase
  u8[] window;         // 32 KiB ring — matches reach back this far after output is handed over
  i32 windowAt;
  Huff lit;            // the current block's tables
  Huff dist;
  u32 crc;             // running, so the trailer is checked without keeping the output
  i32 outSize;
}
```

**Output needs no suspension at all**, which is the part that makes this portable. A
`fn[bool(u8[])] sink` parameter is an ordinary synchronous call — verified working, no JSPI
involved — so output is pushed as it is produced and never accumulated. The `bool` is
back-pressure.

```wac
Status push(this, u8[] chunk, fn[bool(u8[])] sink);
Status finish(this, fn[bool(u8[])] sink);
```

**`Status` is an enum, not a `trap`.** The current `inflate` traps on a CRC mismatch, which is a
compromise the language never forced — and in a streaming decoder it is worse, because a trap
takes down the caller mid-connection.

**Keep the whole-buffer API and implement it on top**: `inflate(data)` is `create`, one `push`, one
`finish`. One implementation, and the existing tests keep their meaning.

**The deflate side is easier and should not copy this shape.** The encoder chooses its own block
boundaries, so it resumes at them by construction: accumulate input up to a block's worth, emit,
repeat. No threshold logic and no partial-symbol question.

### The test that makes it safe

The property worth building first, because it subsumes most of the hand-written cases:

> for every input in the corpus and every chunk split, streaming output is byte-identical to
> whole-buffer output.

Random split points, plus the adversarial ones — a split inside the gzip header, inside a dynamic
table, between a length and its distance, mid-match. If those agree, the resumption logic is right;
if the split-independence property holds, nothing about *where* the chunks fall can matter.

## Or wrap it at the JS level, without touching wac at all

Two of these were measured here rather than reasoned about, and one of them fails.

**Buffering the whole input and calling `inflate` at the end is not a stream.** It has the shape
and none of the properties: memory is O(input) + O(output) and nothing is emitted until the last
byte arrives. Worth naming because it is what usually ships under the word "streaming".

**Compressing each chunk as its own gzip member — measured, and not portable.** Concatenated
members are legal per RFC 1952 §2.2 and three decoders read them as one stream:

| decoder | concatenated members |
|---|---|
| system `gunzip` | reads them |
| Python `gzip.decompress` | reads them |
| Node `zlib.gunzipSync` | reads them |
| **`DecompressionStream("gzip")` (Deno)** | **rejects: "failed to write whole buffer"** |

So the trick works if you control the consumer and fails against the one a browser-side caller
would reach for first. It also costs ratio — a header and trailer per chunk, and no matches across
chunk boundaries. Usable, but it needs the caveat attached, not a footnote.

The *correct* version — one member whose deflate stream is many blocks, realigned with a
`00 00 00 FF FF` sync marker as zlib's `Z_SYNC_FLUSH` does — cannot be assembled in JS from the
current exports, because a non-final compressed block does not end on a byte boundary. That one
needs a wac change, and it is a much smaller change than a streaming decoder.

**Decompression: a worker blocking on `Atomics.wait`, and it works.** This is design A with the
synchronous `read()` it wants, obtained without JSPI:

- the wac module runs in a worker as an ordinary pull loop — no state machine, no compiler change;
- the producer writes chunks into a `SharedArrayBuffer` and calls `Atomics.notify`;
- `read()` blocks in `Atomics.wait` when the buffer is empty, **inside the wasm frame**.

Verified end to end: chunks arriving 5 ms apart, the worker suspended in the middle of a wasm call
each time, the right answer out. Two things that cost time and are not obvious:

- **the feed must be push-only.** A blocked worker cannot deliver a `postMessage`, so it cannot
  *ask* for the next chunk — a request/response handshake deadlocks immediately. The producer
  pushes and the consumer blocks when empty.
- **install the worker's `onmessage` before any top-level `await`**, or the first message is lost
  while module evaluation is suspended.

Costs: one worker and one wasm instantiation per concurrent stream (or a pool), and
`SharedArrayBuffer`. In Deno it is available with no ceremony. In a browser it needs cross-origin
isolation — COOP and COEP headers — which is a deployment constraint on the *page*, not on this
code, and was not testable from here.

### So which

- **Deno or Node, and you want it soon:** the worker wrapper. wac stays a plain loop, no decoder
  rewrite, and it is all host-side code that can be deleted later.
- **Browser, or no SharedArrayBuffer:** the held `Inflater` above. It is the only one with no
  environmental requirement.
- **Compression only, consumer under your control:** per-chunk members today; the sync-flush
  marker when someone wants the ratio back.

## Who wants it

`packages/server` has `gzip` unwired, with `Accept-Encoding` and a compressed body listed as the
obvious next route. `packages/http` also assembles whole bodies in memory and says so. Both would
use a push sink immediately; both would use a real streaming decoder eventually.

Filed rather than done: `gzip` is agent-c's, and this is a rewrite of its decoder rather than a
change beside it.
