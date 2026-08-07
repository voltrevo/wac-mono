// The zstd frame layer, against frames the reference encoder produced.
//
// What is decodable so far is the frame walk and the two block types that carry their content
// plainly. Compressed blocks are the entropy coding and are not implemented, so every case
// here is chosen to produce raw or RLE blocks — and each test asserts *which*, because an
// input that quietly started compressing would turn these into tests of the trap path.

import { wacBind } from "../../../harness/wacBind.ts";
import { refCompress, refDecompress } from "./reference.ts";

const mod = await wacBind("packages/zstd/src/frame.wac") as unknown as {
  decompress(src: Uint8Array): Uint8Array;
};

type Job = { data?: string; decode?: string; level?: number; checksum?: boolean };
type Encoded = { frame: string; blocks: string[] };
type Decoded = { data?: string; error?: string };

// The reference encoder, in this process — see `test/reference.ts` for why this is no longer a
// subprocess. The job shape is kept because the tests below are written against it and it reads well:
// a list of things to compress, a list of frames back.
function encode(jobs: Job[]): Encoded[] {
  return jobs.map((job) => {
    if (job.decode !== undefined) {
      const got = refDecompress(unb64(job.decode));
      return (got === null
        ? { error: "the reference decoder refused the frame" }
        : { data: b64(got) }) as unknown as Encoded;
    }
    const out = refCompress(unb64(job.data!), { level: job.level, checksum: job.checksum });
    return { frame: b64(out.frame), blocks: out.blocks };
  });
}

/** The same, the other way: what the reference decoder makes of these frames. */
function decode(frames: Uint8Array[]): Decoded[] {
  return encode(frames.map((f) => ({ decode: b64(f) }))) as unknown as Decoded[];
}

/** Chunked: spreading a few hundred thousand arguments into fromCharCode overflows the stack. */
function b64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 8192) {
    s += String.fromCharCode(...u.subarray(i, i + 8192));
  }
  return btoa(s);
}
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function prng(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

const enc = new TextEncoder();

/** Inputs the encoder stores rather than compresses, so the frame layer is what is exercised. */
function plainCases(): [string, Uint8Array][] {
  return [
    ["empty", new Uint8Array(0)],
    ["one byte", enc.encode("x")],
    ["two bytes", enc.encode("hi")],
    ["short incompressible", prng(40, 1)],
    // Past 128 KiB, so the encoder has to split it and the block loop runs more than once.
    ["three blocks", prng(300000, 7)],
    ["exactly one block", prng(131072, 9)],
    ["one byte over a block", prng(131073, 11)],
  ];
}

Deno.test("frames the reference encoder produced decode to what went in", async () => {
  const cases = plainCases();
  const results = encode(cases.map(([, d]) => ({ data: b64(d) })));

  for (let i = 0; i < cases.length; i++) {
    const [name, data] = cases[i];
    const { frame, blocks } = results[i];
    if (blocks.includes("compressed")) {
      throw new Error(`${name}: the encoder compressed it (${blocks}), so this is not a frame-layer test`);
    }
    const got = mod.decompress(unb64(frame));
    if (!same(got, data)) {
      throw new Error(`${name}: ${got.length} bytes out, want ${data.length}`);
    }
  }
});

Deno.test("raw blocks are what the corpus above actually exercises", async () => {
  // Worth asserting rather than assuming: if a future zstd started compressing these, the
  // test above would silently become a test of the trap path instead.
  const cases = plainCases();
  const results = encode(cases.map(([, d]) => ({ data: b64(d) })));
  const seen = new Set(results.flatMap(r => r.blocks));
  if (!seen.has("raw")) throw new Error(`no raw block in the corpus: ${[...seen]}`);
});

/** A single-block RLE frame: `count` copies of `value`, single-segment so the size is inline. */
function rleFrame(value: number, count: number): Uint8Array {
  const out: number[] = [0x28, 0xb5, 0x2f, 0xfd];
  // The content-size field has three usable widths and the two-byte one is offset by 256, so
  // it tops out at 65791 rather than 65535. Getting that wrong produced a frame Node rejected.
  if (count < 256) {
    out.push(0x20);                                   // single segment, 1-byte content size
    out.push(count);
  } else if (count < 65792) {
    out.push(0x20 | (1 << 6));                        // single segment, 2-byte content size
    const v = count - 256;
    out.push(v & 0xff, (v >>> 8) & 0xff);
  } else {
    out.push(0x20 | (2 << 6));                        // single segment, 4-byte content size
    out.push(count & 0xff, (count >>> 8) & 0xff, (count >>> 16) & 0xff, (count >>> 24) & 0xff);
  }
  const header = (count << 3) | (1 << 1) | 1;         // size, type RLE, last block
  out.push(header & 0xff, (header >>> 8) & 0xff, (header >>> 16) & 0xff);
  out.push(value);
  return new Uint8Array(out);
}

Deno.test("RLE blocks, on a frame the reference decoder agrees with", async () => {
  // The encoder never emits a frame that is only RLE — it opens with a compressed block — so
  // this one is built by hand. Which would prove nothing on its own, so zstd's own decoder
  // checks the construction first: if Node reads it as the same bytes, the frame is real.
  const cases = [
    [0x61, 1],
    [0x00, 5],
    [0xff, 255],
    [0x41, 256],
    [0x41, 65791],
    [0x7a, 70000],
    [0x2b, 131072],
  ] as [number, number][];

  const frames = cases.map(([v, n]) => rleFrame(v, n));
  const results = decode(frames);

  for (let i = 0; i < cases.length; i++) {
    const [value, count] = cases[i];
    const r = results[i];
    if (r.error !== undefined) throw new Error(`zstd rejected our RLE frame (${value}x${count}): ${r.error}`);
    const want = unb64(r.data!);
    if (want.length !== count) throw new Error(`zstd read ${want.length} bytes, we meant ${count}`);

    const got = mod.decompress(frames[i]);
    if (!same(got, want)) throw new Error(`RLE ${value}x${count}: ${got.length} bytes, want ${want.length}`);
  }
});

Deno.test("a frame that declares its content size is held to it", async () => {
  // Single-segment frames carry the size in the header, which is also how the decoder knows
  // the window. A frame whose body is short of what it promised must not be handed over.
  const data = prng(40, 3);
  const [{ frame }] = encode([{ data: b64(data) }]);
  const bytes = unb64(frame);

  const truncated = bytes.slice(0, bytes.length - 1);
  let trapped = false;
  try {
    mod.decompress(truncated);
  } catch {
    trapped = true;
  }
  if (!trapped) throw new Error("a truncated frame was accepted");
});

Deno.test("concatenated frames are one stream, because the format says so", async () => {
  // `cat a.zst b.zst` is a valid zstd file and decodes to the concatenation.
  const a = prng(50, 5);
  const b = enc.encode("second frame");
  const [ra, rb] = encode([{ data: b64(a) }, { data: b64(b) }]);
  const joined = new Uint8Array([...unb64(ra.frame), ...unb64(rb.frame)]);

  const got = mod.decompress(joined);
  const want = new Uint8Array([...a, ...b]);
  if (!same(got, want)) throw new Error(`${got.length} bytes, want ${want.length}`);
});

Deno.test("a skippable frame is stepped over, not decoded", async () => {
  // Anything at all may sit between frames under a skippable magic — other tools use it for
  // their own metadata, and a decoder that tried to read it would fail on valid input.
  const data = enc.encode("after the skippable");
  const [{ frame }] = encode([{ data: b64(data) }]);

  const payload = enc.encode("this is not zstd data at all");
  const skip = new Uint8Array(8 + payload.length);
  new DataView(skip.buffer).setUint32(0, 0x184D2A50, true);   // the first of the sixteen magics
  new DataView(skip.buffer).setUint32(4, payload.length, true);
  skip.set(payload, 8);

  const got = mod.decompress(new Uint8Array([...skip, ...unb64(frame)]));
  if (!same(got, data)) throw new Error(`${got.length} bytes after a skippable frame`);
});

Deno.test("garbage is refused rather than interpreted", async () => {
  for (const bad of [
    new Uint8Array([0]),
    new Uint8Array([0x28, 0xb5, 0x2f]),                       // the magic, cut short
    new Uint8Array([0x28, 0xb5, 0x2f, 0xfe, 0, 0, 0, 0]),     // a magic that is nearly right
    enc.encode("not compressed at all"),
  ]) {
    let trapped = false;
    try {
      mod.decompress(bad);
    } catch {
      trapped = true;
    }
    if (!trapped) throw new Error(`accepted ${bad.length} bytes of nonsense`);
  }
});
