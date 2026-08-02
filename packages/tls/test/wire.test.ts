// The wire cursor's refusals.
//
// Only the refusals. Everything else about `wire.wac` — big-endian assembly, sub-reader
// bounds, writer/reader round trips — moved to `test/wac/wire_test.wac`, where it reads
// as ordinary calls rather than as opcodes routed through a probe.
//
// These stayed because a rejection in wac is a `trap`, and a trap unwinds the module
// instead of returning, so no wac test can assert one. Catching it needs the host. That
// is a real limit of testing inside wac and the reason this file still exists: a suite
// that could not say "this must be refused" would quietly stop covering the refusals,
// which for a parser fed by the network is most of what matters.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/tls/test/wac/probe.wac");
const read = mod.wireRead as (buf: Uint8Array, op: number, n: number) => number;
const vec = mod.wireVec as (width: number, n: number) => number;

const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
const bytes = (...v: number[]) => Uint8Array.from(v);

const U8 = 0, U16 = 1, U24 = 2, U32 = 3, TAKE = 4, SLICE = 5;
const VEC8 = 6, VEC16 = 7, VEC24 = 8, SUB8 = 9, SUB16 = 10;
const END = 11, TAKE_THEN_END = 12;

Deno.test("wire: reading past the end traps rather than inventing bytes", () => {
  // One byte short in each case, which is the interesting length: a reader that checks
  // its bound before the loop rather than inside it gets this right for u8 and wrong for
  // the wider reads.
  for (const [op, need, name] of [[U8, 1, "u8"], [U16, 2, "u16"], [U24, 3, "u24"], [U32, 4, "u32"]] as const) {
    if (!traps(() => read(new Uint8Array(need - 1), op, 0))) {
      throw new Error(`${name} read past the end of a ${need - 1}-byte buffer`);
    }
  }
});

Deno.test("wire: take and slice refuse a length they cannot satisfy", () => {
  const buf = bytes(1, 2, 3, 4);
  for (const op of [TAKE, SLICE]) {
    if (!traps(() => read(buf, op, 5))) throw new Error("accepted one byte too many");
    // A negative length is not merely too long: it would make `pos + n > end` false and
    // then allocate a negative-sized array, so it has its own check.
    if (!traps(() => read(buf, op, -1))) throw new Error("accepted a negative length");
  }
});

Deno.test("wire: a length prefix that overruns the buffer is refused", () => {
  // The prefix is attacker-controlled and the buffer is not, so "the vector claims 200
  // bytes and there are two" is the ordinary hostile input rather than an edge case.
  if (!traps(() => read(bytes(200, 0xAA), VEC8, 0))) throw new Error("vec8 overran");
  if (!traps(() => read(bytes(0xFF, 0xFF, 0xAA), VEC16, 0))) throw new Error("vec16 overran");
  if (!traps(() => read(bytes(0xFF, 0xFF, 0xFF, 0xAA), VEC24, 0))) throw new Error("vec24 overran");
  if (!traps(() => read(bytes(9, 0xAA), SUB8, 0))) throw new Error("sub8 overran");
  if (!traps(() => read(bytes(0, 9, 0xAA), SUB16, 0))) throw new Error("sub16 overran");
});

Deno.test("wire: expectEnd refuses trailing bytes", () => {
  // Trailing data after a well-formed message is not harmless: accepting a suffix means
  // two byte strings parse to the same handshake, and a transcript hash that no longer
  // identifies what was sent.
  if (!traps(() => read(bytes(1), END, 0))) throw new Error("accepted one trailing byte");
  if (!traps(() => read(bytes(1, 2, 3), TAKE_THEN_END, 2))) throw new Error("accepted a leftover byte");
});

Deno.test("wire: a vector too long for its own length prefix is refused", () => {
  // The writer's half. A 256-byte payload does not fit an eight-bit length, and writing
  // it truncated would produce a message that parses as something shorter.
  if (!traps(() => vec(8, 256))) throw new Error("vec8 accepted 256 bytes");
  if (!traps(() => vec(16, 65536))) throw new Error("vec16 accepted 65536 bytes");
  // vec24's bound is 16 MiB; allocating that to prove the third instance of a pattern the
  // other two establish is not worth the second it costs.
});
