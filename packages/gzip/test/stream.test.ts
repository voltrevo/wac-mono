// Streaming gunzip: `gunzipStream` against the whole-buffer decoder it shares its guts with.
//
// The property that matters, and the only one a chunked decoder can get wrong that a
// whole-buffer one cannot:
//
//   > for any member and any way of cutting it into chunks, the streamed output is
//   > byte-identical to `gunzipBytes` over the same bytes.
//
// `gunzipBytes` is a fair oracle here because the two share `inflateInto` — a disagreement is
// therefore always about *arrival*, never about the format. What the format itself should do is
// already settled by the rest of this directory, which checks against gunzip and python.
//
// Two boundaries carry all the risk and neither is reached by a small input:
//
//   - a **chunk** boundary can fall inside a Huffman code, inside a stored block, or between the
//     compressed data and the trailer;
//   - a **window flush** happens once retained output passes 128 KiB, after which a
//     back-reference reads bytes that have already been handed away — or would, if the window
//     were dropped too eagerly. Every test below that produces more than 128 KiB is there for
//     that one, which is why several inputs are deliberately large and repetitive.

import { pythonGzip } from "./util.ts";
import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/gzip/src/inflate.wac") as unknown as {
  gunzipBytes(gz: Uint8Array): Uint8Array;
  gunzipStream(read: () => Uint8Array, write: (b: Uint8Array) => boolean): number;
};

// One reader and one writer for the whole file: bindgen keeps 16 callback identities per
// signature and never frees one, so a closure per call would die partway through the suite.
let queue: Uint8Array[] = [];
let next = 0;
let parts: Uint8Array[] = [];

function read(): Uint8Array {
  return next < queue.length ? queue[next++] : new Uint8Array(0);
}

function write(b: Uint8Array): boolean {
  parts.push(b.slice());
  return true;
}

function join(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of chunks) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Decompress a member handed over exactly as `chunks` gives it. */
function streamedFrom(chunks: Uint8Array[]): Uint8Array {
  queue = chunks;
  next = 0;
  parts = [];
  mod.gunzipStream(read, write);
  return join(parts);
}

/** Decompress `gz`, handing it over `chunk` bytes at a time. */
function streamed(gz: Uint8Array, chunk: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < gz.length; i += chunk) chunks.push(gz.slice(i, i + chunk));
  return streamedFrom(chunks);
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const enc = new TextEncoder();

Deno.test("streamed output equals the whole-buffer decode, at every chunk size", async () => {
  const text = enc.encode("the quick brown fox jumps over the lazy dog. ".repeat(40));
  const gz = await pythonGzip(text);
  const want = mod.gunzipBytes(gz);

  for (const chunk of [1, 2, 3, 5, 7, 13, 64, 511, 4096, 1 << 20]) {
    const got = streamed(gz, chunk);
    if (!same(got, want)) {
      throw new Error(`chunk size ${chunk}: ${got.length} bytes, want ${want.length}`);
    }
  }
});

Deno.test("a chunk boundary at every single byte of the member", async () => {
  // The exhaustive version of the test above: cut the input in two at every position, so a
  // boundary lands inside the header, inside a code, and inside the trailer.
  const gz = await pythonGzip(enc.encode("streaming gunzip, one boundary at a time. ".repeat(6)));
  const want = mod.gunzipBytes(gz);

  for (let cut = 1; cut < gz.length; cut++) {
    const got = streamedFrom([gz.slice(0, cut), gz.slice(cut)]);
    if (!same(got, want)) throw new Error(`split at ${cut} of ${gz.length}`);
  }
});

Deno.test("output larger than the window flush, so back-references cross it", async () => {
  // Over 128 KiB of output with long-range repetition: matches reach back into bytes that have
  // already been handed to the sink, which is exactly what the retained window is for. A window
  // dropped one byte too eagerly fails here and nowhere smaller.
  const unit = enc.encode("Lorem ipsum dolor sit amet, consectetur adipiscing elit. ");
  const big = new Uint8Array(unit.length * 12000);
  for (let i = 0; i < 12000; i++) big.set(unit, i * unit.length);
  const gz = await pythonGzip(big);
  const want = mod.gunzipBytes(gz);
  if (want.length < 1 << 17) throw new Error(`input too small to reach a flush: ${want.length}`);

  for (const chunk of [1024, 1 << 20]) {
    const got = streamed(gz, chunk);
    if (!same(got, want)) throw new Error(`${got.length} bytes at chunk ${chunk}, want ${want.length}`);
    // Output left before the input ended, which is the difference between streaming and
    // buffering: one call to the sink would mean the whole thing was held to the end.
    if (parts.length < 2) throw new Error(`${want.length} bytes handed over in ${parts.length} call(s)`);
    for (const part of parts) {
      if (part.length > 1 << 17) throw new Error(`a single hand-over of ${part.length} bytes`);
    }
  }
});

Deno.test("incompressible data larger than the flush, which is all stored blocks", async () => {
  // The other block type across a flush. Random bytes deflate to stored blocks, so this walks
  // the byte-at-a-time stored path over more than one window.
  let x = 0x12345678 | 0;
  const rnd = new Uint8Array(200000);
  for (let i = 0; i < rnd.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    rnd[i] = x & 0xff;
  }
  const gz = await pythonGzip(rnd, 0);
  const want = mod.gunzipBytes(gz);
  if (!same(want, rnd)) throw new Error("the buffer decode already disagrees");

  for (const chunk of [777, 1 << 20]) {
    const got = streamed(gz, chunk);
    if (!same(got, rnd)) throw new Error(`stored blocks at chunk ${chunk}: ${got.length} bytes`);
  }
});

Deno.test("header extras are skipped, not mistaken for data", async () => {
  // FNAME is what python sets when it is given a filename, and the streaming header parser is a
  // separate piece of code from the buffer one — it reads forward instead of indexing.
  const data = enc.encode("named member");
  const cmd = new Deno.Command("python3", {
    args: [
      "-c",
      "import sys,gzip,io; b=io.BytesIO(); f=gzip.GzipFile('some-name.txt','wb',6,b); " +
        "f.write(sys.stdin.buffer.read()); f.close(); sys.stdout.buffer.write(b.getvalue())",
    ],
    stdin: "piped",
    stdout: "piped",
  });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(data);
  await w.close();
  const gz = (await child.output()).stdout;
  if (gz[3] !== 8 && (gz[3] & 8) === 0) throw new Error("python did not set FNAME; test is vacuous");

  for (const chunk of [1, 3, 1 << 20]) {
    if (!same(streamed(gz, chunk), data)) throw new Error(`FNAME member at chunk ${chunk}`);
  }
});

Deno.test("a corrupted payload fails its checksum instead of being handed over", async () => {
  const gz = await pythonGzip(enc.encode("integrity matters. ".repeat(50)));
  const bad = gz.slice();
  bad[bad.length - 6] ^= 0xff;            // inside the CRC field of the trailer

  let trapped = false;
  try {
    streamed(bad, 1 << 20);
  } catch {
    trapped = true;
  }
  if (!trapped) throw new Error("a wrong CRC was accepted");
});

Deno.test("truncated input traps rather than returning what it managed", async () => {
  const gz = await pythonGzip(enc.encode("cut me short. ".repeat(80)));
  for (const keep of [5, 20, gz.length - 9, gz.length - 1]) {
    let trapped = false;
    try {
      streamed(gz.slice(0, keep), 1 << 20);
    } catch {
      trapped = true;
    }
    if (!trapped) throw new Error(`${keep} of ${gz.length} bytes was accepted as a whole member`);
  }
});

// ── Compression ───────────────────────────────────────────────────────────────
//
// `gzipStream` is judged by an external decompressor rather than by ours, because a
// compressor that agrees with its own reader has proved nothing. `gunzip` is the oracle.
//
// Its output is *not* expected to be identical across chunk sizes: where the block
// boundaries fall depends on how the input arrives, and a different split is a different
// (still valid) encoding. What must hold at every chunk size is that it decompresses to the
// input, and that it never expands past what a stored member costs.

import { gunzip } from "./util.ts";

const zip = await wacBind("packages/gzip/src/gzip.wac") as unknown as {
  gzipStream(read: () => Uint8Array, write: (b: Uint8Array) => boolean): number;
  gzipBest(d: Uint8Array): Uint8Array;
};

let zqueue: Uint8Array[] = [];
let znext = 0;
let zparts: Uint8Array[] = [];

function zread(): Uint8Array {
  return znext < zqueue.length ? zqueue[znext++] : new Uint8Array(0);
}

function zwrite(b: Uint8Array): boolean {
  zparts.push(b.slice());
  return true;
}

/** Compress `data`, handed over `chunk` bytes at a time. */
function compressed(data: Uint8Array, chunk: number): Uint8Array {
  zqueue = [];
  for (let i = 0; i < data.length; i += chunk) zqueue.push(data.slice(i, i + chunk));
  znext = 0;
  zparts = [];
  zip.gzipStream(zread, zwrite);
  return join(zparts);
}

/** The floor for a member that stores its payload: 18 bytes of frame, 5 per 64 KiB piece. */
function storedFloor(n: number): number {
  return n + 18 + 5 * Math.max(1, Math.ceil(n / 65535));
}

function corpus(): [string, Uint8Array][] {
  let x = 0x2545f491 | 0;
  const rnd = new Uint8Array(300000);
  for (let i = 0; i < rnd.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    rnd[i] = x & 0xff;
  }
  return [
    ["empty", new Uint8Array(0)],
    ["one byte", enc.encode("x")],
    ["prose", enc.encode("the quick brown fox jumps over the lazy dog. ".repeat(50))],
    // Bigger than one chunk, so several blocks, and repetitive enough that matches want to
    // reach across the boundaries between them.
    ["multi-block", enc.encode("Lorem ipsum dolor sit amet, consectetur. ".repeat(20000))],
    ["incompressible", rnd],
  ];
}

Deno.test("gunzip accepts what gzipStream produces, at every chunk size", async () => {
  for (const [name, data] of corpus()) {
    for (const chunk of [1, 997, 1 << 16, 1 << 22]) {
      const gz = compressed(data, chunk);
      const back = await gunzip(gz);
      if (!same(back, data)) {
        throw new Error(`${name} at chunk ${chunk}: ${back.length} bytes back, want ${data.length}`);
      }
    }
  }
});

Deno.test("it never expands past a stored member, whatever it is given", () => {
  // The property gzipBest exists to guarantee over a whole input. A stream cannot look
  // ahead, so it picks a block type per block instead — and incompressible input is where
  // that shows: a dynamic block over random bytes is larger than the bytes.
  for (const [name, data] of corpus()) {
    for (const chunk of [1 << 16, 1 << 22]) {
      const gz = compressed(data, chunk);
      const floor = storedFloor(data.length);
      if (gz.length > floor) {
        throw new Error(`${name} at chunk ${chunk}: ${gz.length} bytes for ${data.length}, above the stored floor of ${floor}`);
      }
    }
  }
});

Deno.test("matches still reach across a block boundary", async () => {
  // The reason each block carries the previous 32 KiB as history. Without it every block
  // starts with an empty window, and repetitive input pays for it: the check is against the
  // whole-input compressor, which has the whole history by definition.
  const data = enc.encode("history has to survive the boundary. ".repeat(20000));
  const streamed = compressed(data, 1 << 16);
  const whole = zip.gzipBest(data);
  if (!same(await gunzip(streamed), data)) throw new Error("does not round trip");

  // Block framing costs something, so the two are not equal — but losing the history would
  // cost far more than this. Measured at 3.9% when written.
  const overhead = (streamed.length - whole.length) / whole.length;
  if (overhead > 0.15) {
    throw new Error(`${streamed.length} streamed vs ${whole.length} whole — ${(overhead * 100).toFixed(1)}% worse, so history is not crossing blocks`);
  }
});

Deno.test("compress and decompress, both streamed, are inverses", async () => {
  // The two halves against each other. A bug shared by both would hide here, which is why
  // gunzip is the oracle above — this one is about the pair composing.
  const data = enc.encode("round and round. ".repeat(9000));
  const gz = compressed(data, 4096);
  const back = streamed(gz, 4096);
  if (!same(back, data)) throw new Error(`${back.length} bytes back, want ${data.length}`);
});
