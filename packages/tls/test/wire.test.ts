// The byte cursor every message is parsed with.
//
// wire.wac had no tests at all. It was covered — the handshake tests drive thousands of
// reads through it — and every one of its bounds checks survived mutation testing anyway,
// because a handshake only ever hands it well-formed input. Well-formed input is the one
// case a wire parser is guaranteed not to get from the network.
//
// The checks matter more here than the arithmetic does. A Reader that runs past its end
// returns whatever is next in memory and calls it a protocol field; one that ignores its
// sub-reader boundary lets a length inside an extension reach into the message after it.
// Both are the shape of bug that reads as a parsing quirk and turns out to be the way in.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/tls/test/wac/probe.wac");
const read = mod.wireRead as (buf: Uint8Array, op: number, n: number) => number;
const vec = mod.wireVec as (width: number, n: number) => number;

const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
const bytes = (...v: number[]) => Uint8Array.from(v);

const U8 = 0, U16 = 1, U24 = 2, U32 = 3, TAKE = 4, SLICE = 5;
const VEC8 = 6, VEC16 = 7, VEC24 = 8, SUB8 = 9, SUB16 = 10;
const END = 11, TAKE_THEN_END = 12, EMPTY = 13;

Deno.test("wire: the fixed-width reads are big-endian", () => {
  // Every length and code point in TLS is big-endian, and a reader that assembled them
  // the other way round would still round-trip against a writer that did the same.
  if (read(bytes(0xAB), U8, 0) !== 0xAB) throw new Error("u8");
  if (read(bytes(0x12, 0x34), U16, 0) !== 0x1234) throw new Error("u16");
  if (read(bytes(0x12, 0x34, 0x56), U24, 0) !== 0x123456) throw new Error("u24");
  if (read(bytes(0x12, 0x34, 0x56, 0x78), U32, 0) !== 0x12345678) throw new Error("u32");
});

Deno.test("wire: reading past the end traps rather than inventing bytes", () => {
  // One byte short in each case, which is the interesting length: a reader that checks
  // its bound before the loop rather than inside it gets this right for u8 and wrong for
  // the wider reads.
  for (const [op, need, name] of [[U8, 1, "u8"], [U16, 2, "u16"], [U24, 3, "u24"], [U32, 4, "u32"]] as const) {
    if (!traps(() => read(new Uint8Array(need - 1), op, 0))) {
      throw new Error(`${name} read past the end of a ${need - 1}-byte buffer`);
    }
    if (read(new Uint8Array(need), op, 0) !== 0) throw new Error(`${name} failed on exactly enough bytes`);
  }
});

Deno.test("wire: take and slice refuse a length they cannot satisfy", () => {
  const buf = bytes(1, 2, 3, 4);
  for (const op of [TAKE, SLICE]) {
    if (read(buf, op, 4) !== 4) throw new Error("exactly the whole buffer should work");
    if (read(buf, op, 0) !== 0) throw new Error("zero should work");
    if (!traps(() => read(buf, op, 5))) throw new Error("accepted one byte too many");
    // A negative length is not merely too long: it would make `pos + n > end` false and
    // then allocate a negative-sized array, so it has its own check.
    if (!traps(() => read(buf, op, -1))) throw new Error("accepted a negative length");
  }
});

Deno.test("wire: a length prefix that overruns the buffer is refused", () => {
  // The case that matters on the wire. The prefix is attacker-controlled and the buffer
  // is not, so "the vector says 200 bytes and there are 3" is the normal hostile input.
  if (read(bytes(2, 0xAA, 0xBB), VEC8, 0) !== 2) throw new Error("a good vec8 failed");
  if (!traps(() => read(bytes(200, 0xAA), VEC8, 0))) throw new Error("vec8 overran");
  if (read(bytes(0, 2, 0xAA, 0xBB), VEC16, 0) !== 2) throw new Error("a good vec16 failed");
  if (!traps(() => read(bytes(0xFF, 0xFF, 0xAA), VEC16, 0))) throw new Error("vec16 overran");
  if (read(bytes(0, 0, 2, 0xAA, 0xBB), VEC24, 0) !== 2) throw new Error("a good vec24 failed");
  if (!traps(() => read(bytes(0xFF, 0xFF, 0xFF, 0xAA), VEC24, 0))) throw new Error("vec24 overran");

  // And the sub-reader forms, which is how nested vectors are parsed.
  if (read(bytes(2, 0xAA, 0xBB), SUB8, 0) !== 2) throw new Error("a good sub8 failed");
  if (!traps(() => read(bytes(9, 0xAA), SUB8, 0))) throw new Error("sub8 overran");
  if (read(bytes(0, 2, 0xAA, 0xBB), SUB16, 0) !== 2) throw new Error("a good sub16 failed");
  if (!traps(() => read(bytes(0, 9, 0xAA), SUB16, 0))) throw new Error("sub16 overran");
});

Deno.test("wire: expectEnd refuses trailing bytes", () => {
  // Trailing data after a well-formed message is not harmless. RFC 8446 §4 messages have
  // exact lengths, and accepting a suffix means two different byte strings parse to the
  // same handshake — which is a transcript hash that no longer identifies what was sent.
  if (read(new Uint8Array(0), END, 0) !== 0) throw new Error("an empty reader is at its end");
  if (!traps(() => read(bytes(1), END, 0))) throw new Error("accepted one trailing byte");
  if (read(bytes(1, 2, 3), TAKE_THEN_END, 3) !== 0) throw new Error("consuming everything should be at the end");
  if (!traps(() => read(bytes(1, 2, 3), TAKE_THEN_END, 2))) throw new Error("accepted a leftover byte");
});

Deno.test("wire: empty() answers for the boundary, not just the middle", () => {
  if (read(new Uint8Array(0), EMPTY, 0) !== 1) throw new Error("an empty buffer is empty");
  if (read(bytes(1), EMPTY, 0) !== 0) throw new Error("a one-byte buffer is not empty");
});

Deno.test("wire: a vector too long for its own length prefix is refused", () => {
  // The writer's half. A 256-byte payload does not fit an eight-bit length, and writing
  // it truncated would produce a message that parses as something shorter — a length
  // field disagreeing with its contents is how a parser and a serialiser drift apart.
  if (vec(8, 255) !== 256) throw new Error("255 bytes should fit a vec8");
  if (!traps(() => vec(8, 256))) throw new Error("vec8 accepted 256 bytes");
  if (vec(16, 65535) !== 65537) throw new Error("65535 bytes should fit a vec16");
  if (!traps(() => vec(16, 65536))) throw new Error("vec16 accepted 65536 bytes");
  // vec24's bound is 16 MiB. Allocating that to prove the check is not worth the second
  // it costs, and the two below it establish the pattern; the guard is recorded as
  // untested rather than tested badly.
});
