// Malformed *dynamic* (BTYPE=10) blocks, and the stored-block and gzip-header checks.
//
// inflate_adversarial.test.ts covers the paths reachable with the fixed Huffman code,
// which needs no transmitted tables and so can be written by hand cheaply. Everything
// in the dynamic header — the three biased counts, the code-length code, the
// run-length-encoded length sequence — was unreachable that way, and every validity
// check in `readDynamicLengths` was therefore untested. So were the stored block's
// NLEN complement check, the reserved BTYPE, and the gzip header's compression-method
// check.
//
// These are the checks a decoder exists to perform. `inflate` takes bytes from
// wherever the caller got them, which for a decompressor is the definition of
// untrusted input, and a missing check here is not a wrong answer — it is an
// out-of-range index or a run that writes past its table.
//
// Every stream below was confirmed to reach the specific branch it names, by running it
// against an instrumented build and checking that line's counter went from zero. That
// matters more than usual here: a hand-built stream that is malformed in two ways at
// once traps on the first, and would look like it tested the second.

import { wacBind } from "../../../harness/wacBind.ts";
import { Bits, dynamicHeader, fillZeros, mustTrap, storedBlock, type ClOp } from "./streams.ts";

const mod = await wacBind("packages/gzip/src/inflate.wac");
const inflate = mod.inflate as (data: Uint8Array) => Uint8Array;
const gunzipBytes = mod.gunzipBytes as (gz: Uint8Array) => Uint8Array;

const traps = (name: string, stream: Uint8Array) => mustTrap(inflate, name, stream);

/**
 * Code-length codes for the sequences below. Each is a *complete* code — the
 * Kraft sum is exactly 1 — because an incomplete one is itself a malformation and
 * would trap in `Decoder.build` before the sequence was ever read.
 */
const CL_REPEAT = clCode({ 16: 1, 0: 1 });                     // just repeat and zero
const CL_FULL = clCode({ 18: 2, 0: 2, 1: 2, 16: 2 });          // + long zero runs, + length 1
const CL_RUNS = clCode({ 0: 1, 18: 2, 17: 2 });                // both zero-run symbols

function clCode(lengths: Record<number, number>): number[] {
  const out = new Array(19).fill(0);
  for (const [sym, len] of Object.entries(lengths)) out[Number(sym)] = len;
  return out;
}

/**
 * A complete dynamic block that decodes to "A", with the given HLIT and HDIST.
 *
 * Everything else about the stream is valid, so the only thing a decoder can object to
 * is the pair of counts. That is what makes it a test of the count check rather than of
 * whatever happens to fail first — the distinction that let a mutation of that check
 * survive the previous version of this test.
 *
 * Only three symbols get a code: 'A' at 65, end-of-block at 256, and the first distance
 * code, which sits at index `hlit` because the distance lengths follow the literal ones
 * in one run-length-encoded sequence rather than starting a new table.
 */
function completeDynamic(hlit: number, hdist: number): Uint8Array {
  const total = hlit + hdist;
  const b = dynamicHeader({
    hlit,
    hdist,
    clLengths: CL_FULL,
    ops: [
      ...fillZeros(65), { sym: 1 },
      ...fillZeros(190), { sym: 1 },
      ...fillZeros(hlit - 257), { sym: 1 },
      ...fillZeros(total - hlit - 1),
    ],
  });
  b.code(0, 1).code(1, 1);   // literal 'A', then end-of-block; both are 1-bit codes
  return b.done();
}

Deno.test("inflate/dynamic: HLIT and HDIST beyond what the format defines", () => {
  // HLIT is sent as HLIT-257 in five bits, so 287 and 288 are encodable while RFC 1951
  // defines only 286 literal/length codes. HDIST is sent as HDIST-1, so 31 and 32 are
  // encodable against 30 defined distance codes. Both would size a table larger than
  // the fixed length/distance base arrays the decoder indexes with the symbol, so
  // accepting them turns a header field into an out-of-range read.
  // These streams are complete and correct apart from the count, which is the only way
  // to test the check rather than merely reach it. The first version of this test sent a
  // header and stopped, so the stream ran out of bits and trapped whether or not the
  // count was validated — it executed the line without testing it. A mutation run caught
  // that by deleting the check and watching every test still pass.
  //
  // With the check gone, `hlit = 287` decodes to "A" and returns successfully: nothing
  // else objects, because symbols 286 and 287 simply have no code assigned to them.
  for (const hlit of [287, 288]) {
    traps(`hlit ${hlit}, otherwise valid`, completeDynamic(hlit, 1));
  }
  for (const hdist of [31, 32]) {
    traps(`hdist ${hdist}, otherwise valid`, completeDynamic(257, hdist));
  }
  // The largest legal pair must still be accepted, or the bound could be off by one in
  // the other direction and every test above would still pass.
  const got = new TextDecoder().decode(inflate(completeDynamic(286, 30)));
  if (got !== "A") throw new Error(`hlit=286 hdist=30 should decode to "A", got ${JSON.stringify(got)}`);
});

Deno.test("inflate/dynamic: a repeat code with nothing before it to repeat", () => {
  // Symbol 16 means "repeat the previous code length". As the first symbol in the
  // sequence there is no previous length, and the natural implementation reads
  // lengths[-1].
  traps("sym 16 at i=0", dynamicHeader({
    hlit: 257, hdist: 1, clLengths: CL_REPEAT, ops: [{ sym: 16, extra: 0 }],
  }).done());
});

Deno.test("inflate/dynamic: a run that overruns the end of the length table", () => {
  // All three run symbols write a variable number of entries, and none of the counts is
  // bounded by how much table is left: symbol 16 writes up to 6, symbol 17 up to 10,
  // symbol 18 up to 138. A run that starts legally and ends past the table is the
  // interesting case — the write is in range when the loop begins.
  //
  // The table here is 257 + 1 = 258 entries, and each sequence fills to just short of
  // that before starting a run too long to fit.
  const cases: [string, ClOp[], number[]][] = [
    ["sym 16", [...fillZeros(255), { sym: 1 }, { sym: 16, extra: 1 }], CL_FULL],
    ["sym 17", [...fillZeros(256), { sym: 17, extra: 0 }], CL_RUNS],
    ["sym 18", [...fillZeros(250), { sym: 18, extra: 0 }], CL_RUNS],
  ];
  for (const [name, ops, cl] of cases) {
    traps(`${name} run past the table`, dynamicHeader({
      hlit: 257, hdist: 1, clLengths: cl, ops,
    }).done());
  }
});

Deno.test("inflate/dynamic: a run that ends exactly at the table's end is valid", () => {
  // The positive control for the test above. `i >= total` inside the loop is correct;
  // `i + run > total` checked before it would also pass every case above while
  // rejecting this one, which is legal and does occur in real streams — a table whose
  // final entries are zero is exactly what a small alphabet produces.
  const b = dynamicHeader({
    hlit: 257, hdist: 1, clLengths: CL_FULL,
    // 65 zeros, 'A', 190 zeros, end-of-block, then the single distance length — the
    // last op lands on the final entry with nothing left over.
    ops: [...fillZeros(65), { sym: 1 }, ...fillZeros(190), { sym: 1 }, { sym: 1 }],
  });
  b.code(0, 1).code(1, 1);
  const got = new TextDecoder().decode(inflate(b.done()));
  if (got !== "A") throw new Error(`expected "A", got ${JSON.stringify(got)}`);
});

Deno.test("inflate/stored: NLEN must be the one's complement of LEN", () => {
  // The format carries LEN twice, once inverted, so a decoder can catch a corrupt
  // length before trusting it. Skipping the check does not corrupt the output visibly —
  // it produces a plausible number of bytes from the wrong place.
  const cases: [string, number, number][] = [
    ["NLEN zero", 0x0001, 0x0000],
    ["NLEN equal to LEN", 0x0001, 0x0001],
    ["NLEN off by one", 0x0005, 0xFFFA ^ 1],
  ];
  for (const [name, len, nlen] of cases) {
    const s = new Uint8Array([
      ...storedBlock().done(),
      len & 0xFF, (len >> 8) & 0xFF, nlen & 0xFF, (nlen >> 8) & 0xFF,
      ...new Uint8Array(len).fill(0x41),
    ]);
    traps(name, s);
  }
  // And the matching pair decodes, so the check is not simply always failing.
  const good = new Uint8Array([...storedBlock().done(), 0x02, 0x00, 0xFD, 0xFF, 0x41, 0x42]);
  const got = new TextDecoder().decode(inflate(good));
  if (got !== "AB") throw new Error(`a valid stored block should decode to "AB", got ${JSON.stringify(got)}`);
});

Deno.test("inflate/stored: truncated before LEN and NLEN are complete", () => {
  // A stored block needs four header bytes after the align. Fewer than four means
  // reading LEN or NLEN off the end of the input.
  const header = storedBlock().done();
  for (const extra of [0, 1, 2, 3]) {
    traps(`${extra} of 4 header bytes`, new Uint8Array([...header, ...new Uint8Array(extra)]));
  }
});

Deno.test("inflate: BTYPE 11 is reserved", () => {
  // The one block type the format leaves undefined. A decoder that falls through here
  // silently produces empty output for a stream it does not understand.
  traps("BTYPE=11", new Bits().bits(1, 1).bits(3, 2).done());
  traps("BTYPE=11 after a valid block", new Uint8Array([
    ...(() => { const b = new Bits().bits(0, 1).bits(0, 2); return b.done(); })(),
    0x01, 0x00, 0xFE, 0xFF, 0x41,      // a non-final stored block holding "A"
    0x07,                              // BFINAL=1, BTYPE=11
  ]));
});

Deno.test("gunzip: CM must be 8 (deflate)", () => {
  // The only compression method gzip ever defined. Values 0-7 are reserved and 9+
  // undefined; a decoder that ignores the field runs the deflate decoder over bytes
  // that are not deflate.
  for (const cm of [0, 1, 7, 9, 255]) {
    const gz = new Uint8Array(20);
    gz[0] = 0x1F;
    gz[1] = 0x8B;
    gz[2] = cm;
    mustTrap(gunzipBytes, `CM=${cm}`, gz);
  }
});
