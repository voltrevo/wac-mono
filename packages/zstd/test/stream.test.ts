// Streaming unzstd: `unzstdStream` against the whole-buffer decoder it shares its guts with.
//
// The property that matters, and the only one a chunked decoder can get wrong that a whole-buffer one
// cannot:
//
//   > for any frame and any way of cutting it into chunks, the streamed output is byte-identical to
//   > `decompress` over the same bytes.
//
// `decompress` is a fair oracle because the two share `decodeCompressed` and the sequence execution — a
// disagreement is therefore always about *arrival*, never about the format. What the format itself should
// do is settled by the rest of this directory, which checks against zstd's own vectors.
//
// wac-mono 0088 asked for exactly this shape, borrowed from `packages/gzip/test/stream.test.ts`, which
// 0006 wrote for the same reason: fixed vectors do not find boundary bugs, and cutting at every byte does.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/zstd/src/stream.wac") as unknown as {
  unzstdStream(read: () => unknown, write: (b: Uint8Array) => boolean): bigint;
  Read: { Data(bytes: Uint8Array): unknown; End(): unknown; Failed(why: string): unknown };
};
const buffered = await wacBind("packages/zstd/src/frame.wac") as unknown as {
  decompress(src: Uint8Array): Uint8Array;
};
// The encoder is its own module, so the frames under test are made by this package rather than described
// by hand — which also means a change that broke both ends the same way would not show up here. The rest
// of this directory checks the format against zstd's own vectors; this file checks arrival.
const encoder = await wacBind("packages/zstd/src/encode.wac") as unknown as {
  compress(data: Uint8Array): Uint8Array;
};

// One reader and one writer for the whole file: bindgen keeps 16 callback identities per signature and
// never frees one, so a closure per call would die partway through the suite. `packages/gzip`'s streaming
// test says the same and found out the hard way.
let queue: Uint8Array[] = [];
let next = 0;
let parts: Uint8Array[] = [];

function read(): unknown {
  return next < queue.length ? mod.Read.Data(queue[next++]) : mod.Read.End();
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

/** Decode `src`, handing it over `chunk` bytes at a time. */
function streamed(src: Uint8Array, chunk: number): Uint8Array {
  queue = [];
  for (let i = 0; i < src.length; i += chunk) queue.push(src.slice(i, i + chunk));
  next = 0;
  parts = [];
  mod.unzstdStream(read, write);
  return join(parts);
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Inputs that exercise different block types and match distances. */
function corpus(): Uint8Array[] {
  const enc = new TextEncoder();
  const out: Uint8Array[] = [
    new Uint8Array(0),
    enc.encode("a"),
    enc.encode("hello hello hello hello"),
    // Long runs become RLE or long matches.
    new Uint8Array(5000).fill(0x41),
  ];
  // Incompressible: raw blocks, and the checksum path over a large frame.
  const noise = new Uint8Array(9000);
  let s = 12345;
  for (let i = 0; i < noise.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    noise[i] = (s >> 16) & 0xff;
  }
  out.push(noise);
  // Repetitive over more than one block, so matches reach back across a block boundary.
  const line = enc.encode("the quick brown fox jumps over the lazy dog 0123456789\n");
  const many = new Uint8Array(line.length * 4000);
  for (let i = 0; i < 4000; i++) many.set(line, i * line.length);
  out.push(many);
  return out;
}

Deno.test("every frame, cut every possible way, decodes to what the buffered decoder gives", () => {
  for (const data of corpus()) {
    const frame = encoder.compress(data);
    const want = buffered.decompress(frame);
    if (!same(want, data)) throw new Error("the buffered decoder disagrees with the input — fix that first");

    // Every chunk size up to the whole frame for the small ones; a spread for the large, because
    // O(n²) over a megabyte is minutes rather than seconds and adds nothing after the first few.
    const sizes = frame.length <= 600
      ? Array.from({ length: frame.length + 1 }, (_, i) => i + 1)
      : [1, 2, 3, 5, 7, 13, 64, 127, 128, 1024, 4096, frame.length - 1, frame.length, frame.length + 1];
    for (const chunk of sizes) {
      const got = streamed(frame, chunk);
      if (!same(got, want)) {
        throw new Error(
          `input of ${data.length} bytes, frame of ${frame.length}, cut every ${chunk}: ` +
            `got ${got.length} bytes, want ${want.length}`,
        );
      }
    }
  }
});

Deno.test("a frame arriving in one piece is the same as one arriving in many", () => {
  // The degenerate case, kept separate because it is the one a hand-written test would have written:
  // it passes for a decoder that ignores chunking entirely, which is why it is not the test above.
  const data = new TextEncoder().encode("zstd streaming, one piece at a time".repeat(50));
  const frame = encoder.compress(data);
  if (!same(streamed(frame, frame.length), buffered.decompress(frame))) {
    throw new Error("whole-frame streaming disagrees with the buffered decoder");
  }
});
