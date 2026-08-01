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

## Who wants it

`packages/server` has `gzip` unwired, with `Accept-Encoding` and a compressed body listed as the
obvious next route. `packages/http` also assembles whole bodies in memory and says so. Both would
use a push sink immediately; both would use a real streaming decoder eventually.

Filed rather than done: `gzip` is agent-c's, and this is a rewrite of its decoder rather than a
change beside it.
