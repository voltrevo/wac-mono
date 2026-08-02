// The encoder, judged by zstd's own decoder.
//
// This is the test the decoder never had available to it: an encoder's first valid frame is
// checkable end to end, because Node must decompress it to exactly what went in. Our own
// decoder is checked too, but second — a bug shared by both halves would hide there, and the
// point of Node is that it cannot share one.
//
// Ratio is measured but only loosely asserted. What is worth failing on is *expansion*, and
// beating a stored frame on data that obviously compresses; the rest is recorded so a change
// that quietly loses ground is visible in the numbers rather than in a threshold nobody trusts.

import { wacBind } from "../../../harness/wacBind.ts";

const enc = await wacBind("packages/zstd/src/encode.wac") as unknown as {
  compress(data: Uint8Array): Uint8Array;
};
const dec = await wacBind("packages/zstd/src/frame.wac") as unknown as {
  decompress(src: Uint8Array): Uint8Array;
};

const e = new TextEncoder();

function b64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return btoa(s);
}
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** Decompress with Node's zstd; null where it refused the frame. */
async function nodeDecompress(frames: Uint8Array[]): Promise<(Uint8Array | null)[]> {
  const script = `
    const z = require("zlib");
    const c = [];
    process.stdin.on("data", d => c.push(d)).on("end", () => {
      const jobs = JSON.parse(Buffer.concat(c).toString());
      process.stdout.write(JSON.stringify(jobs.map(j => {
        try { return z.zstdDecompressSync(Buffer.from(j, "base64")).toString("base64"); }
        catch (e) { return null; }
      })));
    });`;
  const cmd = new Deno.Command("node", { args: ["-e", script], stdin: "piped", stdout: "piped", stderr: "piped" });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(JSON.stringify(frames.map(b64))));
  await w.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) throw new Error(`node failed: ${new TextDecoder().decode(stderr)}`);
  return (JSON.parse(new TextDecoder().decode(stdout)) as (string | null)[])
    .map(s => s === null ? null : unb64(s));
}

function same(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return i;
  }
  return -2;
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

/** Chosen for the encoder paths they reach: no matches, only matches, block boundaries. */
function corpus(): [string, Uint8Array][] {
  return [
    ["empty", new Uint8Array(0)],
    ["one byte", e.encode("x")],
    ["two bytes", e.encode("ab")],
    // Shorter than the minimum match, so nothing can match at all.
    ["under the minimum match", e.encode("ab")],
    ["no repetition", e.encode("abcdefghijklmnop")],
    ["one match", e.encode("abcabc")],
    ["a match at the very end", e.encode("xyzabcabc")],
    ["short repetition", e.encode("hello hello hello hello world")],
    ["prose", e.encode("the quick brown fox jumps over the lazy dog. ".repeat(300))],
    ["json", e.encode(JSON.stringify(Array.from({ length: 1500 }, (_, i) => ({ id: i, name: "item" + i }))))],
    ["one long run", new Uint8Array(50000).fill(0x61)],
    // Incompressible, so every block falls back to raw.
    ["random", prng(200000, 7)],
    // Past one block, so the block loop runs and a match can reach across the boundary.
    ["multi-block", e.encode("Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(9000))],
    // Exactly a block, and one byte over.
    ["exactly one block", prng(131072, 3)],
    ["one byte over a block", prng(131073, 5)],
    // Compressible and incompressible together, so both block kinds appear in one frame.
    ["mixed", new Uint8Array([...e.encode("aaaa".repeat(20000)), ...prng(60000, 11), ...e.encode("bbbb".repeat(20000))])],
    ["every byte value", new Uint8Array(Array.from({ length: 100000 }, (_, i) => i & 0xff))],
  ];
}

Deno.test("zstd decompresses what we produce, back to the original", async () => {
  const cases = corpus();
  const frames = cases.map(([, d]) => enc.compress(d));
  const back = await nodeDecompress(frames);

  for (let i = 0; i < cases.length; i++) {
    const [name, data] = cases[i];
    const got = back[i];
    if (got === null) throw new Error(`${name}: zstd refused our ${frames[i].length}-byte frame`);
    const at = same(got, data);
    if (at === -1) throw new Error(`${name}: zstd read ${got.length} bytes, want ${data.length}`);
    if (at >= 0) throw new Error(`${name}: zstd's output differs at byte ${at} of ${data.length}`);
  }
});

Deno.test("and so does our own decoder", () => {
  // Second, not first. A misunderstanding shared by both halves would pass here and fail above,
  // which is exactly why Node goes first.
  for (const [name, data] of corpus()) {
    const got = dec.decompress(enc.compress(data));
    const at = same(got, data);
    if (at !== -2) {
      throw new Error(`${name}: ${at === -1 ? `${got.length} bytes, want ${data.length}` : `differs at ${at}`}`);
    }
  }
});

Deno.test("it never expands past a stored frame", () => {
  // The property that matters most: a compressor that grows its input is worse than none. Each
  // block falls back to raw when the compressed form is not smaller, so the ceiling is the
  // input plus the frame's own frame — 14 bytes of header and checksum, and 3 per block.
  for (const [name, data] of corpus()) {
    const blocks = Math.max(1, Math.ceil(data.length / 131072));
    const ceiling = data.length + 14 + 3 * blocks;
    const got = enc.compress(data).length;
    if (got > ceiling) {
      throw new Error(`${name}: ${got} bytes for ${data.length} in, above the stored ceiling of ${ceiling}`);
    }
  }
});

Deno.test("data that obviously compresses, obviously compresses", () => {
  // A canary rather than a threshold: these are inputs where any working match finder wins by a
  // wide margin, so the numbers are loose enough to survive a change of strategy and tight
  // enough to catch a match finder that has stopped finding matches.
  const cases: [string, Uint8Array, number][] = [
    ["one repeated byte", new Uint8Array(50000).fill(0x61), 200],
    ["one repeated phrase", e.encode("the quick brown fox. ".repeat(5000)), 300],
    ["a long file of one line", e.encode("2026-08-02 INFO nothing happened\n".repeat(3000)), 400],
  ];
  for (const [name, data, ceiling] of cases) {
    const got = enc.compress(data).length;
    if (got > ceiling) throw new Error(`${name}: ${got} bytes for ${data.length}, expected under ${ceiling}`);
  }
});

Deno.test("fuzz: every shape and size round trips through zstd", async () => {
  // Sizes and shapes rather than content: the block boundary, the minimum match, and the last
  // few bytes of a buffer are where an encoder goes wrong, and those are functions of length.
  let seed = 0xBEEF | 0;
  const rand = (n: number): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed % n;
  };

  const inputs: Uint8Array[] = [];
  const names: string[] = [];
  for (let i = 0; i < 80; i++) {
    const n = rand(6000);
    const kind = rand(4);
    let data: Uint8Array;
    if (kind === 0) {
      data = prng(n, seed);
      names.push(`${n} random bytes`);
    } else if (kind === 1) {
      data = new Uint8Array(n).fill(0x41 + rand(26));
      names.push(`${n} of one byte`);
    } else if (kind === 2) {
      const unit = "abcdefghij".slice(0, 1 + rand(9));
      data = e.encode(unit.repeat(Math.ceil(n / unit.length)).slice(0, n));
      names.push(`${n} of "${unit}"`);
    } else {
      // Repetition with noise, which is where matches and literals mix.
      const noise = prng(n, seed);
      const out = new Uint8Array(n);
      for (let j = 0; j < n; j++) out[j] = j % 20 < 15 ? 0x61 + (j % 5) : noise[j];
      data = out;
      names.push(`${n} mixed`);
    }
    inputs.push(data);
  }

  const frames = inputs.map(d => enc.compress(d));
  const back = await nodeDecompress(frames);
  for (let i = 0; i < inputs.length; i++) {
    const got = back[i];
    if (got === null) throw new Error(`${names[i]}: zstd refused the frame`);
    const at = same(got, inputs[i]);
    if (at !== -2) {
      throw new Error(`${names[i]}: ${at === -1 ? `${got.length} bytes, want ${inputs[i].length}` : `differs at ${at}`}`);
    }
  }
});
