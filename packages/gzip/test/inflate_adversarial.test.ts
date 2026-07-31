// Hand-crafted malformed deflate streams.
//
// These exist because mutation testing found a hole: removing inflate's
// "distance points before the start of the output" check entirely did not fail a
// single test. Random corruption never reaches that code — a flipped bit in a
// Huffman-coded stream almost always breaks the symbol decode first, so the
// stream dies well before a distance is ever validated. Reaching those checks
// takes a stream built on purpose.
//
// Streams are assembled bit by bit with the fixed Huffman code, which needs no
// transmitted tables and so can be written by hand. The builder lives in streams.ts,
// shared with inflate_dynamic_adversarial.test.ts and with cov.ts — the coverage run
// drives these same streams, so the report describes a workload that is actually
// asserted on.

import { wacBind } from "../../../harness/wacBind.ts";
import { Bits, fixedBlock, mustTrap } from "./streams.ts";

const inflateMod = await wacBind("packages/gzip/src/inflate.wac");
const inflateRaw = inflateMod.inflate as (data: Uint8Array) => Uint8Array;

const traps = (name: string, stream: Uint8Array) => mustTrap(inflateRaw, name, stream);

Deno.test("inflate/adversarial: distance pointing before the start of the output", () => {
  // One literal, so the output is 1 byte. Then a length-3 match at distance 5,
  // which would read four bytes before the output began.
  //   symbol 257 = length 3 (no extra bits)
  //   distance symbol 4 = distances 5-6, 1 extra bit; extra 0 -> distance 5
  const s = fixedBlock()
    .literal(0x41)          // "A", output length is now 1
    .litLenSymbol(257)      // length 3
    .code(4, 5).bits(0, 1)  // distance 5 > 1
    .done();
  traps("distance 5 with 1 byte of output", s);
});

Deno.test("inflate/adversarial: distance exactly equal to the output length is valid", () => {
  // The positive control for the test above: distance == output length reaches
  // the very first byte, which is legal and must NOT trap. Without this, the
  // bound could be tightened to `d >= out.len` and look fine.
  const s = fixedBlock()
    .literal(0x41)          // "A"
    .litLenSymbol(257)      // length 3
    .code(0, 5)             // distance symbol 0 = distance 1, no extra bits
    .litLenSymbol(256)      // end of block
    .done();
  const got = inflateRaw(s);
  const text = new TextDecoder().decode(got);
  if (text !== "AAAA") throw new Error(`expected "AAAA", got ${JSON.stringify(text)}`);
});

Deno.test("inflate/adversarial: a distance just past the output length traps", () => {
  // Two literals, then distance 3 — one past the 2 bytes available. This is the
  // exact off-by-one the bound protects, and the case a `d > out.len + 1` bound
  // would wrongly accept.
  const s = fixedBlock()
    .literal(0x41)
    .literal(0x42)          // output length is now 2
    .litLenSymbol(257)      // length 3
    .code(2, 5)             // distance symbol 2 = distance 3, no extra bits
    .done();
  traps("distance 3 with 2 bytes of output", s);
});

Deno.test("inflate/adversarial: a match at the very start of a block", () => {
  // Zero literals emitted, so any distance at all is out of range.
  const s = fixedBlock()
    .litLenSymbol(257)      // length 3, with nothing to copy from
    .code(0, 5)             // distance 1
    .done();
  traps("match before any output exists", s);
});

Deno.test("inflate/adversarial: reserved literal/length symbols 286 and 287", () => {
  // The fixed code assigns bit patterns to 286 and 287, but RFC 1951 says they
  // "will never actually occur in the compressed data". A decoder must reject
  // them rather than index past its length table.
  for (const sym of [286, 287]) {
    const s = fixedBlock().literal(0x41).litLenSymbol(sym).done();
    traps(`literal/length symbol ${sym}`, s);
  }
});

Deno.test("inflate/adversarial: reserved distance symbols 30 and 31", () => {
  // Same for the distance alphabet: the fixed code is 5 bits wide, so 30 and 31 are
  // expressible bit patterns but not defined symbols.
  //
  // Worth being precise about where these are caught, because it is not where the
  // matching literal/length case is caught. The fixed distance decoder is built with
  // exactly 30 symbols, so no code is assigned to 30 or 31 and the stream dies inside
  // `Decoder.decode` for want of a matching code. The reserved *literal* symbols 286
  // and 287 do have codes — the fixed literal table has 288 entries — so those decode
  // successfully and are caught by an explicit bound in `inflateBlock`. See the comment
  // on the `di >= 30` check, which is unreachable for this reason.
  for (const sym of [30, 31]) {
    const s = fixedBlock()
      .literal(0x41)
      .litLenSymbol(257)    // length 3
      .code(sym, 5)
      .done();
    traps(`distance symbol ${sym}`, s);
  }
});

Deno.test("inflate/adversarial: stored block with a length that runs off the end", () => {
  // BTYPE=00 with LEN claiming more bytes than the stream contains.
  const s = new Bits()
    .bits(1, 1).bits(0, 2)  // BFINAL=1, BTYPE=00
    .done();
  const withLen = new Uint8Array([...s, 0xFF, 0x00, 0x00, 0xFF, 0x41]);  // LEN=255, only 1 byte follows
  traps("stored LEN past end of input", withLen);
});

Deno.test("inflate/adversarial: truncated mid-symbol", () => {
  // Running out of bits partway through a Huffman code must trap, not return
  // whatever has been decoded so far.
  const full = fixedBlock().literal(0x41).literal(0x42).litLenSymbol(256).done();
  for (let keep = 0; keep < full.length; keep++) {
    traps(`truncated to ${keep} of ${full.length} bytes`, full.slice(0, keep));
  }
});

Deno.test("inflate/adversarial: a block that never ends", () => {
  // Literals with no end-of-block symbol: the decoder must run out of input and
  // trap rather than loop.
  const b = fixedBlock();
  for (let i = 0; i < 100; i++) b.literal(0x41);
  traps("no end-of-block symbol", b.done());
});
