// Branch coverage for gzip.
//
// gzip was the one package with no cov.ts, because `tools/coverage.ts` had hand-written
// gzip exercises from back when gzip was the only package there was. Those exercises are
// carried over here unchanged, and the two now measure different things: the shared tool
// runs each package's *wac-native* tests, and a cov.ts runs the host-driven exercises
// that wac cannot express — a fuzz corpus, a python oracle, streams assembled bit by bit.
// Neither subsumes the other, so gzip is measured by both.
//
// What this adds over the tool's version is the hand-built adversarial streams from
// test/streams.ts. The tool did not drive them, and that omission mattered: it reported
// sixteen uncovered branch points in inflate.wac. Of those, four already had tests and
// only looked uncovered because its workload was narrower than the suite's — the reserved
// literal symbols, a stored length past the end, and the FNAME skip loop, which
// inflate.test.ts reaches through the gzip CLI. Eleven were genuinely untested and now
// have tests. One is unreachable; see UNREACHABLE below.
//
//   deno task coverage:gzip
//   deno task coverage:gzip --verbose
//
// The compressor and the decompressor are separate entry points, so each gets its own
// instrumented module and counter array. Files reachable from both — buf, crc32,
// tables — appear in both, and `report` merges per (file, line, col, kind), so the
// union is what counts.

import { instrument, report } from "../../harness/wacCoverage.ts";
import { buildCorpus } from "./test/fuzz/corpus.ts";
import { Bits, dynamicHeader, fillZeros, fixedBlock, storedBlock, type ClOp } from "./test/streams.ts";

const verbose = Deno.args.includes("--verbose");
const enc = new TextEncoder();

/** Swallow the trap. Every malformed stream below is *asserted* on in the test suite;
 * here the only thing that matters is that the branch was reached. */
function ignoringTraps(call: () => unknown): void {
  try {
    call();
  } catch { /* the rejection is the point; the assertion lives in the tests */ }
}

// ── The compressor ────────────────────────────────────────────────────────────

const gz = await instrument("packages/gzip/src/gzip.wac");
const gzRead = gz.mod.Read as { Data(b: Uint8Array): unknown; End(): unknown };
const gzipStored = gz.mod.gzipStored as (d: Uint8Array) => Uint8Array;
const gzipFixed = gz.mod.gzipFixed as (d: Uint8Array) => Uint8Array;
const gzipDynamic = gz.mod.gzipDynamic as (d: Uint8Array) => Uint8Array;
const gzipBest = gz.mod.gzipBest as (d: Uint8Array) => Uint8Array;

// The fuzz corpus is the broadest set of shapes available, and reusing it means this
// measures roughly what the suite measures.
for (const { data } of buildCorpus(120, 20260731)) {
  gzipStored(data);
  gzipFixed(data);
  gzipDynamic(data);
  gzipBest(data);
}
// Plus the boundary lengths the corpus does not guarantee: the empty input, a match
// longer than the maximum, and the 65535-byte stored-block limit either side.
for (const n of [0, 1, 2, 3, 258, 65535, 65536, 131071]) {
  const runs = new Uint8Array(n).fill(0x61);
  gzipBest(runs);
  gzipDynamic(runs);
  gzipStored(runs);
}

// ── The decompressor ──────────────────────────────────────────────────────────

const inf = await instrument("packages/gzip/src/inflate.wac");
/** `Read`'s variant constructors, from each instrumented module — a wac enum crosses as a class. */
const infRead = inf.mod.Read as { Data(b: Uint8Array): unknown; End(): unknown };
const gunzipBytes = inf.mod.gunzipBytes as (gz: Uint8Array) => Uint8Array;
const inflate = inf.mod.inflate as (d: Uint8Array) => Uint8Array;

// Round trips through all three block types, so stored, fixed and dynamic all appear.
for (const { data } of buildCorpus(60, 20260731)) {
  for (const compress of [gzipBest, gzipStored, gzipFixed]) {
    ignoringTraps(() => gunzipBytes(compress(data)));
  }
}

// Corruption and truncation of a valid stream. This reaches the checks that a damaged
// stream trips early — the magic, the CRC, the ISIZE — and nothing deeper, which is why
// the hand-built streams below exist.
const valid = gzipBest(enc.encode("coverage of error paths ".repeat(20)));
for (let i = 0; i < valid.length; i += 3) {
  const bad = valid.slice();
  bad[i] ^= 0xFF;
  ignoringTraps(() => gunzipBytes(bad));
  ignoringTraps(() => gunzipBytes(valid.slice(0, i)));
}

// ── The decoder's own validity checks ─────────────────────────────────────────
//
// The same streams test/inflate_adversarial.test.ts and
// test/inflate_dynamic_adversarial.test.ts assert on. Random corruption does not reach
// any of this: a flipped bit breaks the symbol decode long before a distance is
// validated or a code-length run overruns its table.

/** Fixed-code streams: reserved symbols, and distances out of range. */
const fixed = fixedBlock;
ignoringTraps(() => inflate(fixed().literal(0x41).litLenSymbol(257).code(4, 5).bits(0, 1).done()));
ignoringTraps(() => inflate(fixed().literal(0x41).literal(0x42).litLenSymbol(257).code(2, 5).done()));
ignoringTraps(() => inflate(fixed().litLenSymbol(257).code(0, 5).done()));
for (const sym of [286, 287]) {
  ignoringTraps(() => inflate(fixed().literal(0x41).litLenSymbol(sym).done()));
}
for (const sym of [30, 31]) {
  ignoringTraps(() => inflate(fixed().literal(0x41).litLenSymbol(257).code(sym, 5).done()));
}
// The legal boundary: distance equal to the output length must decode.
inflate(fixed().literal(0x41).litLenSymbol(257).code(0, 5).litLenSymbol(256).done());
// Truncation at every byte, and a block with no end-of-block symbol.
const whole = fixed().literal(0x41).literal(0x42).litLenSymbol(256).done();
for (let keep = 0; keep < whole.length; keep++) {
  ignoringTraps(() => inflate(whole.slice(0, keep)));
}
ignoringTraps(() => {
  const b = fixed();
  for (let i = 0; i < 100; i++) b.literal(0x41);
  return inflate(b.done());
});

/** Stored blocks: a short header, a bad complement, a length past the end. */
ignoringTraps(() => inflate(storedBlock().done()));
for (const extra of [1, 2, 3]) {
  ignoringTraps(() => inflate(new Uint8Array([...storedBlock().done(), ...new Uint8Array(extra)])));
}
ignoringTraps(() => inflate(new Uint8Array([...storedBlock().done(), 0x01, 0x00, 0x00, 0x00, 0x41])));
ignoringTraps(() => inflate(new Uint8Array([...storedBlock().done(), 0xFF, 0x00, 0x00, 0xFF, 0x41])));
inflate(new Uint8Array([...storedBlock().done(), 0x02, 0x00, 0xFD, 0xFF, 0x41, 0x42]));

/** The reserved block type. */
ignoringTraps(() => inflate(new Bits().bits(1, 1).bits(3, 2).done()));

/** Dynamic headers, valid and malformed. */
const cl = (lengths: Record<number, number>) => {
  const out = new Array(19).fill(0);
  for (const [sym, len] of Object.entries(lengths)) out[Number(sym)] = len;
  return out;
};
const CL_REPEAT = cl({ 16: 1, 0: 1 });
const CL_FULL = cl({ 18: 2, 0: 2, 1: 2, 16: 2 });
const CL_RUNS = cl({ 0: 1, 18: 2, 17: 2 });

for (const hlit of [287, 288]) {
  ignoringTraps(() => inflate(dynamicHeader({ hlit, hdist: 1, clLengths: CL_REPEAT, ops: [] }).done()));
}
for (const hdist of [31, 32]) {
  ignoringTraps(() => inflate(dynamicHeader({ hlit: 257, hdist, clLengths: CL_REPEAT, ops: [] }).done()));
}
ignoringTraps(() => inflate(dynamicHeader({
  hlit: 257, hdist: 1, clLengths: CL_REPEAT, ops: [{ sym: 16, extra: 0 }],
}).done()));
const overruns: [ClOp[], number[]][] = [
  [[...fillZeros(255), { sym: 1 }, { sym: 16, extra: 1 }], CL_FULL],
  [[...fillZeros(256), { sym: 17, extra: 0 }], CL_RUNS],
  [[...fillZeros(250), { sym: 18, extra: 0 }], CL_RUNS],
];
for (const [ops, clLengths] of overruns) {
  ignoringTraps(() => inflate(dynamicHeader({ hlit: 257, hdist: 1, clLengths, ops }).done()));
}
// A valid dynamic block, and the largest legal HLIT/HDIST pair.
{
  const b = dynamicHeader({
    hlit: 257, hdist: 1, clLengths: CL_FULL,
    ops: [...fillZeros(65), { sym: 1 }, ...fillZeros(190), { sym: 1 }, { sym: 1 }],
  });
  b.code(0, 1).code(1, 1);
  inflate(b.done());
}
{
  const b = dynamicHeader({
    hlit: 286, hdist: 30, clLengths: CL_FULL,
    ops: [
      ...fillZeros(65), { sym: 1 }, ...fillZeros(190), { sym: 1 },
      ...fillZeros(29), { sym: 1 }, ...fillZeros(29),
    ],
  });
  b.code(0, 1).code(1, 1);
  inflate(b.done());
}

/** The gzip header: a bad compression method, and each optional field. */
for (const cm of [0, 1, 7, 9, 255]) {
  const bad = new Uint8Array(20);
  bad[0] = 0x1F;
  bad[1] = 0x8B;
  bad[2] = cm;
  ignoringTraps(() => gunzipBytes(bad));
}
{
  const payload = enc.encode("optional header fields\n".repeat(8));
  const base = gzipBest(payload);
  const cstr = (s: string) => [...enc.encode(s), 0];
  const withFields = (flg: number, fields: number[]) => new Uint8Array([
    base[0], base[1], base[2], flg, base[4], base[5], base[6], base[7], base[8], base[9],
    ...fields, ...base.subarray(10),
  ]);
  const name = cstr("archive.tar"), comment = cstr("a comment"), extra = [4, 0, 65, 66, 67, 68];
  gunzipBytes(withFields(8, name));                                  // FNAME
  gunzipBytes(withFields(16, comment));                              // FCOMMENT
  gunzipBytes(withFields(4, extra));                                 // FEXTRA
  gunzipBytes(withFields(2, [0x12, 0x34]));                          // FHCRC
  gunzipBytes(withFields(8 | 16, [...name, ...comment]));
  gunzipBytes(withFields(4 | 8 | 16 | 2, [...extra, ...name, ...comment, 0x12, 0x34]));
  gunzipBytes(withFields(8, cstr("")));                              // empty name
  gunzipBytes(withFields(4, [0, 0]));                                // empty extra
  // A name with no terminator: the skip loop's length bound rather than its NUL bound.
  ignoringTraps(() => gunzipBytes(new Uint8Array([
    base[0], base[1], base[2], 8, base[4], base[5], base[6], base[7], base[8], base[9],
    ...enc.encode("no-terminator-anywhere-in-this-name-at-all"),
  ])));
}

// ── crc32 on its own ──────────────────────────────────────────────────────────
//
// crc32Bitwise is the reference the table version is checked against, so the pipeline
// never calls it. Instrumenting crc32.wac separately keeps the number honest rather
// than reporting a tested function as dead.

const crc = await instrument("packages/gzip/src/crc32.wac");
const crc32 = crc.mod.crc32 as (d: Uint8Array) => number;
const crc32Bitwise = crc.mod.crc32Bitwise as (d: Uint8Array) => number;
for (const n of [0, 1, 2, 255, 256, 4096]) {
  const data = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xFF);
  if (crc32(data) !== crc32Bitwise(data)) {
    throw new Error(`crc32 disagrees with crc32Bitwise at length ${n}`);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

/**
 * Branch points that cannot be reached, with the reason.
 *
 * Named rather than tolerated as a percentage below 100: a report that sits at 99.6%
 * forever teaches everyone to ignore the last line, and then a genuinely new gap
 * arrives and looks like the one that was always there. Anything not listed here is
 * expected to be covered and the run fails if it is not — and anything listed that
 * *does* get covered fails too, since the reason has stopped holding.
 *
 * `snippet` is checked against the source at that line. Keying an exclusion on a line
 * number alone is fragile in the obvious way: adding a comment above it silently moves
 * the exclusion onto whatever now sits at that line. This list started out pointing at
 * line 306 and the comment explaining why moved the code to 322, which is exactly the
 * mistake worth catching automatically rather than remembering.
 */
const UNREACHABLE: { file: string; line: number; snippet: string; why: string }[] = [
  {
    file: "packages/gzip/src/inflate.wac",
    line: 129,
    snippet: "while (left > 0 && this.bitCount >= 8) {",
    why: "copyBytes is only ever called straight after alignByte and two readBits(16). " +
      "alignByte leaves a multiple of 8 bits, fill only ever adds whole bytes, and skip " +
      "removes exactly 16 — so the bit buffer is empty by the time this runs, and this " +
      "loop drains nothing. Kept because it is what makes copyBytes correct on its own " +
      "terms rather than by the habits of its one caller: a second caller that aligned " +
      "differently would otherwise read the payload from the wrong offset, silently.",
  },
  {
    file: "packages/gzip/src/inflate.wac",
    line: 574,
    snippet: "if (di >= 30) { trap; }",
    why: "Both distance decoders are built with at most 30 symbols — the fixed one with " +
      "exactly 30, the dynamic one with hdist, already bounded at 30 — so decode cannot " +
      "return 30. A stream using distance code 30 or 31 traps inside decode for want of a " +
      "matching code. Kept as defence: it stops being dead if the fixed distance table is " +
      "widened to the 32 patterns 5 bits allow.",
  },
];

/** Every (file, line) with at least one branch point that never ran. */
function uncoveredLines(): Set<string> {
  const seen = new Map<string, boolean>();
  for (const run of [gz, inf, crc]) {
    const counts = run.counts();
    for (const p of run.points) {
      if (!p.file.startsWith("packages/gzip/src/")) continue;
      const key = `${p.file}:${p.line}:${p.col}:${p.kind}`;
      seen.set(key, (seen.get(key) ?? false) || counts[p.index] > 0);
    }
  }
  const out = new Set<string>();
  for (const [key, hit] of seen) {
    if (!hit) out.add(key.split(":").slice(0, 2).join(":"));
  }
  return out;
}

// ── The streaming decoder ─────────────────────────────────────────────────────
//
// `gunzipStream` shares `inflateInto` with `gunzipBytes`, so the format work above already
// covers most of what it runs. What is left is the parts that only exist because the input
// arrives in pieces: the reader's pull, the header read forward instead of indexed, the
// sliding window, and the trailer checked at the end rather than the start.
//
// Chunk size is the axis that matters. One byte at a time makes the reader exhaust its
// buffer on nearly every call; a single huge chunk never exhausts it at all.

const gunzipStream = inf.mod.gunzipStream as (
  read: () => unknown,
  write: (b: Uint8Array) => boolean,
) => number;

// Stable identities: bindgen keeps 16 per signature and never frees one.
let feed: Uint8Array[] = [];
let feedAt = 0;
let sinkAccepts = true;

function covRead(): Uint8Array {
  return feedAt < feed.length ? infRead.Data(feed[feedAt++]) : infRead.End();
}

function covWrite(): boolean {
  return sinkAccepts;
}

function stream(gz: Uint8Array, chunk: number, accepts = true): void {
  feed = [];
  for (let i = 0; i < gz.length; i += chunk) feed.push(gz.slice(i, i + chunk));
  feedAt = 0;
  sinkAccepts = accepts;
  ignoringTraps(() => gunzipStream(covRead, covWrite));
}

for (const { data } of buildCorpus(12, 20260801)) {
  for (const compress of [gzipBest, gzipStored, gzipFixed]) {
    const member = compress(data);
    for (const chunk of [1, 7, 4096, 1 << 20]) stream(member, chunk);
  }
}
// An empty member, which is the only way the window is asked to hand over nothing.
for (const compress of [gzipBest, gzipStored, gzipFixed]) {
  stream(compress(new Uint8Array(0)), 1 << 20);
}

// Past the 128 KiB flush, in both directions: repetitive input keeps the window busy with
// back-references that reach across a hand-over, and incompressible input walks the stored
// path over more than one window.
const repetitive = enc.encode("windows slide and matches reach back. ".repeat(6000));
for (const chunk of [512, 1 << 20]) stream(gzipBest(repetitive), chunk);
const noisy = new Uint8Array(200000);
for (let i = 0; i < noisy.length; i++) noisy[i] = (i * 2654435761) & 0xFF;
for (const chunk of [999, 1 << 20]) stream(gzipStored(noisy), chunk);
// The same length again but Huffman-coded, so it arrives as literals rather than as a bulk
// copy. That is the only way the window's per-byte flush check is the one that fires: a
// match crossing the limit is handled before the copy starts, not during it.
//
// Genuinely random rather than a multiplicative pattern — `(i * k) & 0xFF` repeats every
// 256 bytes, so it codes as matches and crosses the limit inside one, which is the other
// branch entirely.
const noise = new Uint8Array(200000);
let ns = 0x1a2b3c4d | 0;
for (let i = 0; i < noise.length; i++) {
  ns ^= ns << 13; ns >>>= 0;
  ns ^= ns >>> 17;
  ns ^= ns << 5; ns >>>= 0;
  noise[i] = ns & 0xFF;
}
for (const chunk of [999, 1 << 20]) stream(gzipDynamic(noise), chunk);

// Small members, so the output window is allocated below its floor and handed over in one
// piece, and truncations of a *stored* stream, which fails inside the bulk byte copy rather
// than inside a Huffman decode.
for (const body of [new Uint8Array(0), enc.encode("x"), enc.encode("a short one")]) {
  for (const chunk of [1, 1 << 20]) stream(gzipStored(body), chunk);
  ignoringTraps(() => gunzipBytes(gzipStored(body)));
}
const storedStream = gzipStored(enc.encode("stored and cut short ".repeat(4000)));
for (let i = 8; i < storedStream.length; i += 37) stream(storedStream.slice(0, i), 1 << 20);

// A sink that refuses. The bytes are dropped either way — the window has to stay bounded
// whatever the consumer does — so this is about the refusal path, not the output.
stream(gzipBest(repetitive), 1 << 20, false);

// Every optional header field, which the streaming parser reads forward one byte at a time.
// Hand-built rather than produced, because no encoder here emits FEXTRA or FCOMMENT.
function member(flg: number, extras: number[], body: Uint8Array): Uint8Array {
  const plain = gzipBest(body);
  const head = [0x1F, 0x8B, 8, flg, 0, 0, 0, 0, 0, 3, ...extras];
  const out = new Uint8Array(head.length + plain.length - 10);
  out.set(head, 0);
  out.set(plain.subarray(10), head.length);
  return out;
}
const small = enc.encode("header flags");
for (
  const [flg, extras] of [
    [4, [3, 0, 1, 2, 3]],                       // FEXTRA, XLEN=3
    [8, [0x61, 0x62, 0]],                       // FNAME
    [16, [0x68, 0x69, 0]],                      // FCOMMENT
    [2, [0xAB, 0xCD]],                          // FHCRC
    [4 | 8 | 16 | 2, [1, 0, 9, 0x61, 0, 0x62, 0, 0xAB, 0xCD]],   // all four at once
  ] as [number, number[]][]
) {
  for (const chunk of [1, 1 << 20]) stream(member(flg, extras, small), chunk);
}

// Rejections along the streaming path: bad magic, wrong compression method, a broken
// trailer, and every truncation of a valid member.
const goodStream = gzipBest(enc.encode("streamed error paths ".repeat(30)));
for (const mangle of [0, 1, 2]) {
  const bad = goodStream.slice();
  bad[mangle] ^= 0xFF;
  stream(bad, 1 << 20);
}
for (const back of [1, 5, 8]) {
  const bad = goodStream.slice();
  bad[bad.length - back] ^= 0xFF;
  stream(bad, 1 << 20);
}
for (let i = 0; i < goodStream.length; i += 5) stream(goodStream.slice(0, i), 1 << 20);

// ── The streaming compressor ──────────────────────────────────────────────────
//
// `gzipStream` shares its matcher and its block writer with the whole-input compressors, so
// what is left is the streaming frame: the fill loop, the chunk cap, the history carried
// between blocks, and the per-block choice between dynamic and stored.
//
// Chunk size drives most of it. Feeding one byte at a time makes the fill loop iterate for
// every byte; feeding more than a chunk at once makes it overshoot and leave a remainder
// for the next block, which is a different path through the same code.

const gzipStream = gz.mod.gzipStream as (
  read: () => unknown,
  write: (b: Uint8Array) => boolean,
) => number;

let zfeed: Uint8Array[] = [];
let zfeedAt = 0;

function zcovRead(): Uint8Array {
  return zfeedAt < zfeed.length ? gzRead.Data(zfeed[zfeedAt++]) : gzRead.End();
}

function zcovWrite(): boolean {
  return true;
}

function compressStream(data: Uint8Array, chunk: number): void {
  zfeed = [];
  for (let i = 0; i < data.length; i += chunk) zfeed.push(data.slice(i, i + chunk));
  zfeedAt = 0;
  ignoringTraps(() => gzipStream(zcovRead, zcovWrite));
}

for (const { data } of buildCorpus(10, 20260802)) {
  for (const chunk of [1, 4096, 1 << 20]) compressStream(data, chunk);
}
// The empty input, which still has to emit a final block.
compressStream(new Uint8Array(0), 1 << 20);

// More than one block, so history is carried and the chunk cap is reached — and a feed
// larger than a chunk, so the fill overshoots and leaves a remainder behind.
const manyBlocks = enc.encode("blocks and blocks and blocks. ".repeat(20000));
for (const chunk of [4096, 1 << 16, 1 << 19]) compressStream(manyBlocks, chunk);

// Incompressible, so the per-block comparison picks stored — including a length that needs
// more than one 64 KiB piece within a single block.
const random = new Uint8Array(300000);
for (let i = 0; i < random.length; i++) random[i] = (i * 2654435761) >>> 13 & 0xFF;
for (const chunk of [1 << 16, 1 << 20]) compressStream(random, chunk);

report([gz, inf, crc], "packages/gzip/src/", { verbose });

let failed = false;
const uncovered = uncoveredLines();

for (const u of UNREACHABLE) {
  const where = `${u.file}:${u.line}`;
  const source = (await Deno.readTextFile(u.file)).split("\n")[u.line - 1] ?? "";
  if (!source.includes(u.snippet)) {
    console.log(`\n${where} no longer holds ${JSON.stringify(u.snippet)} — it holds:\n  ${source.trim()}`);
    console.log(`  The UNREACHABLE entry has drifted onto the wrong line; fix the line number.`);
    failed = true;
  } else if (!uncovered.has(where)) {
    console.log(`\n${where} is listed as unreachable but was covered. The reason given was:`);
    console.log(`  ${u.why}\n  That reason no longer holds — drop the entry.`);
    failed = true;
  } else {
    console.log(`\nexcluded as unreachable: ${where}  ${u.snippet}`);
    console.log(`  ${u.why}`);
  }
}

const unexpected = [...uncovered].filter(u => !UNREACHABLE.some(e => `${e.file}:${e.line}` === u));
if (unexpected.length > 0) {
  console.log(`\n${unexpected.length} reachable branch point(s) uncovered:`);
  for (const u of unexpected.sort()) console.log(`  ${u}`);
  failed = true;
}
if (failed) Deno.exit(1);
