// The whole decoder, against zstd's own encoder.
//
// Every test above this one checks a piece against an invariant, because until a compressed
// block decodes end to end there is nothing to compare bytes with. Now there is: Node's zlib
// carries zstd, so a frame goes in and the original must come out, byte for byte.
//
// That makes this the test that matters and the others the ones that localise a failure. The
// corpus is chosen to reach the paths a decoder has, not the data a user has: every literals
// kind, every sequence-code mode, block boundaries, and the repeat-offset rules.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/zstd/src/frame.wac") as unknown as {
  decompress(src: Uint8Array): Uint8Array;
};

type Params = { level?: number; checksum?: boolean };

/** Compress with Node's zstd; one subprocess for the whole batch. */
async function compress(inputs: Uint8Array[], params: Params = {}): Promise<Uint8Array[]> {
  const script = `
    const z = require("zlib");
    const chunks = [];
    process.stdin.on("data", d => chunks.push(d)).on("end", () => {
      const jobs = JSON.parse(Buffer.concat(chunks).toString());
      const params = {};
      if (jobs.level !== undefined) params[z.constants.ZSTD_c_compressionLevel] = jobs.level;
      if (jobs.checksum) params[z.constants.ZSTD_c_checksumFlag] = 1;
      const out = jobs.data.map(d =>
        z.zstdCompressSync(Buffer.from(d, "base64"), { params }).toString("base64"));
      process.stdout.write(JSON.stringify(out));
    });`;
  const cmd = new Deno.Command("node", { args: ["-e", script], stdin: "piped", stdout: "piped", stderr: "piped" });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(JSON.stringify({ data: inputs.map(b64), ...params })));
  await w.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) throw new Error(`node failed: ${new TextDecoder().decode(stderr)}`);
  return (JSON.parse(new TextDecoder().decode(stdout)) as string[]).map(unb64);
}

function b64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return btoa(s);
}
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

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

const enc = new TextEncoder();

/** Inputs chosen for the decoder paths they reach rather than for realism. */
function corpus(): [string, Uint8Array][] {
  const cases: [string, Uint8Array][] = [
    ["empty", new Uint8Array(0)],
    ["one byte", enc.encode("x")],
    ["two bytes", enc.encode("hi")],
    // Short and repetitive: predefined sequence tables, because a block this small cannot
    // afford to transmit its own.
    ["short repeat", enc.encode("hello hello hello hello world")],
    ["one long run", new Uint8Array(50000).fill(0x61)],
    // A run of one byte becomes RLE literals; two alternating bytes do not.
    ["alternating", enc.encode("ab".repeat(20000))],
    ["prose", enc.encode("the quick brown fox jumps over the lazy dog. ".repeat(300))],
    ["prose, long", enc.encode("the quick brown fox jumps over the lazy dog, and again. ".repeat(6000))],
    ["json", enc.encode(JSON.stringify(Array.from({ length: 1500 }, (_, i) => ({ id: i, name: "item" + i }))))],
    // Incompressible: raw literals, and raw blocks at the frame level.
    ["random", prng(300000, 7)],
    // Compressible and incompressible in one frame, so blocks of different kinds meet.
    ["mixed", new Uint8Array([...enc.encode("aaaa".repeat(20000)), ...prng(60000, 11), ...enc.encode("bbbb".repeat(20000))])],
    // Past one block, so a match can reach across a block boundary and the tables can repeat.
    ["multi-block", enc.encode("Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(9000))],
    // Every byte value, so the Huffman alphabet is as wide as it gets.
    ["all bytes", new Uint8Array(Array.from({ length: 100000 }, (_, i) => i & 0xff))],
    // Long matches at long distances, which is what the repeat-offset slots are for.
    ["distant matches", (() => {
      const unit = prng(40000, 3);
      const out = new Uint8Array(unit.length * 3);
      out.set(unit, 0);
      out.set(prng(unit.length, 9), unit.length);
      out.set(unit, unit.length * 2);
      return out;
    })()],
  ];
  return cases;
}

Deno.test("every frame decodes to exactly what was compressed", async () => {
  const cases = corpus();
  const frames = await compress(cases.map(([, d]) => d));
  for (let i = 0; i < cases.length; i++) {
    const [name, data] = cases[i];
    const got = mod.decompress(frames[i]);
    const at = same(got, data);
    if (at === -1) throw new Error(`${name}: ${got.length} bytes out, want ${data.length}`);
    if (at >= 0) throw new Error(`${name}: first difference at byte ${at} of ${data.length}`);
  }
});

Deno.test("at every compression level, which chooses different codings", async () => {
  // Level changes what the encoder does, not what it means: higher levels find longer matches
  // and use more offset repeats, and level 1 leans on predefined tables. A decoder that is
  // right at one level and wrong at another has got a mode wrong rather than an algorithm.
  const data = enc.encode(
    JSON.stringify(Array.from({ length: 800 }, (_, i) => ({ id: i, tag: "x".repeat(i % 17) }))),
  );
  for (const level of [1, 3, 9, 15, 19]) {
    const [frame] = await compress([data], { level });
    const got = mod.decompress(frame);
    const at = same(got, data);
    if (at !== -2) throw new Error(`level ${level}: ${at === -1 ? `${got.length} bytes` : `differs at ${at}`}`);
  }
});

Deno.test("frames that carry a checksum are still read", async () => {
  // The trailer is four bytes of XXH64 and is not verified yet — but it has to be stepped over,
  // and a frame walk that ignores it reads the checksum as the start of another frame.
  const data = enc.encode("checksummed content ".repeat(500));
  const [frame] = await compress([data], { checksum: true });
  const got = mod.decompress(frame);
  if (same(got, data) !== -2) throw new Error(`checksummed frame: ${got.length} bytes, want ${data.length}`);
});

Deno.test("fuzz: random inputs of every size round trip", async () => {
  // Sizes rather than content: the block and stream boundaries fall at fixed offsets, so what
  // finds an off-by-one is a length that lands on one.
  const inputs: Uint8Array[] = [];
  const names: string[] = [];
  let seed = 0xC0FFEE | 0;
  for (let i = 0; i < 60; i++) {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    const n = seed % 5000;
    // Mostly compressible, so sequences appear rather than raw blocks only.
    const unit = "abcdefghij".slice(0, 1 + (seed % 9));
    const text = unit.repeat(Math.ceil(n / Math.max(1, unit.length))).slice(0, n);
    inputs.push(enc.encode(text));
    names.push(`${n} bytes of "${unit}"`);
  }
  const frames = await compress(inputs);
  for (let i = 0; i < inputs.length; i++) {
    const got = mod.decompress(frames[i]);
    const at = same(got, inputs[i]);
    if (at !== -2) throw new Error(`${names[i]}: ${at === -1 ? `${got.length} bytes, want ${inputs[i].length}` : `differs at ${at}`}`);
  }
});

import { frameShapes } from "./frames.ts";

/** Inputs big enough, and levels high enough, that the encoder reaches for its rarer codings. */
function wideCorpus(): [string, Uint8Array, number][] {
  const json = enc.encode(JSON.stringify(Array.from({ length: 60000 }, (_, i) => ({ id: i, name: "item" + i }))));
  const logs = enc.encode(
    Array.from({ length: 40000 }, (_, i) => `2026-08-02T10:00:00Z INFO request id=${i} path=/api/items status=200 ms=${i % 97}\n`).join(""),
  );
  return [
    ["json 2MB @9", json, 9],
    ["json 2MB @19", json, 19],
    ["logs 2MB @1", logs, 1],
    ["logs 2MB @19", logs, 19],
  ];
}

Deno.test("the rarer codings decode too, and are actually reached", async () => {
  // Treeless literals reuse the previous block's Huffman tree; Repeat mode reuses the previous
  // block's FSE table; RLE means a code has one symbol and no table at all. None of them appear
  // in a small file, because there is no previous block to inherit from and nothing to save.
  //
  // Each is a path a decoder must have and a corpus can easily never reach — so this asserts
  // what was reached as well as that it decoded, and fails if a future encoder stops choosing
  // them rather than quietly testing nothing.
  const kinds = new Set<string>();
  const modes = new Set<string>();

  // Both corpora, because the codings live at opposite ends: predefined tables are what a
  // *small* block uses, since it cannot afford to transmit its own, while treeless and repeat
  // need a previous block to inherit from and only appear once a file is large.
  const all: [string, Uint8Array, number | undefined][] = [
    ...corpus().map(([n, d]) => [n, d, undefined] as [string, Uint8Array, undefined]),
    ...wideCorpus(),
  ];

  for (const [name, data, level] of all) {
    const [frame] = await compress([data], level === undefined ? {} : { level });
    for (const k of frameShapes(frame).kinds) kinds.add(k);
    for (const m of frameShapes(frame).modes) {
      for (const part of m.split(" ")) modes.add(part.split(":")[1] ?? part);
    }
    const got = mod.decompress(frame);
    const at = same(got, data);
    if (at !== -2) {
      throw new Error(`${name}: ${at === -1 ? `${got.length} bytes, want ${data.length}` : `differs at byte ${at}`}`);
    }
  }

  for (const want of ["raw", "rle", "compressed", "treeless"]) {
    if (!kinds.has(want)) throw new Error(`no ${want} literals section in the corpus: saw ${[...kinds]}`);
  }
  for (const want of ["predefined", "fse", "repeat", "rle"]) {
    if (!modes.has(want)) throw new Error(`no sequence code in ${want} mode: saw ${[...modes]}`);
  }
});

Deno.test("a corrupted frame fails its checksum", async () => {
  // The only check in the format that catches a frame which decoded without complaint into the
  // wrong bytes — everything else verifies that the encoding made sense, not that the answer is
  // right. Flipping a bit in the compressed data usually breaks the encoding outright, so this
  // flips the *stored checksum* instead: the content is fine, and the frame must still be
  // refused because what it claims about itself is not true.
  const data = enc.encode("integrity matters here ".repeat(400));
  const [frame] = await compress([data], { checksum: true });

  const ok = mod.decompress(frame);
  if (same(ok, data) !== -2) throw new Error("the untouched frame does not decode");

  for (let i = 1; i <= 4; i++) {
    const bad = frame.slice();
    bad[bad.length - i] ^= 0x40;
    let trapped = false;
    try {
      mod.decompress(bad);
    } catch {
      trapped = true;
    }
    if (!trapped) throw new Error(`a frame with byte ${i} of its checksum flipped was accepted`);
  }
});

Deno.test("a frame that needs a dictionary is refused, not guessed at", async () => {
  // Dictionaries are not implemented. What matters is that a frame needing one fails rather
  // than producing plausible rubbish — so this checks the two shapes such a frame can take.
  const dict = enc.encode("the quick brown fox jumps over the lazy dog ".repeat(20));
  const data = enc.encode("the quick brown fox jumps over the lazy dog again and again");

  const script = `
    const z = require("zlib");
    const c = [];
    process.stdin.on("data", d => c.push(d)).on("end", () => {
      const { dict, data } = JSON.parse(Buffer.concat(c).toString());
      process.stdout.write(JSON.stringify({
        withDict: z.zstdCompressSync(Buffer.from(data, "base64"), { dictionary: Buffer.from(dict, "base64") }).toString("base64"),
        plain: z.zstdCompressSync(Buffer.from(data, "base64")).toString("base64"),
      }));
    });`;
  const cmd = new Deno.Command("node", { args: ["-e", script], stdin: "piped", stdout: "piped" });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(JSON.stringify({ dict: b64(dict), data: b64(data) })));
  await w.close();
  const r = JSON.parse(new TextDecoder().decode((await child.output()).stdout)) as { withDict: string; plain: string };

  // The same content without a dictionary still decodes, so the refusal below is about the
  // dictionary and not about this content.
  if (same(mod.decompress(unb64(r.plain)), data) !== -2) throw new Error("the plain frame does not decode");

  // A raw-content dictionary declares no identifier, so it cannot be detected from the header.
  // It is refused because a match reaches back before the start of the output.
  let trapped = false;
  try {
    mod.decompress(unb64(r.withDict));
  } catch {
    trapped = true;
  }
  if (!trapped) throw new Error("a frame compressed against a dictionary was decoded anyway");

  // A frame that *declares* a dictionary identifier is refused on sight. Built by hand, because
  // producing one needs a trained dictionary: the header's low two bits give the identifier's
  // width, and one byte of it is enough.
  const declared = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20 | 1, 7, 0x01, ...unb64(r.plain).slice(6)]);
  let refused = false;
  try {
    mod.decompress(declared);
  } catch {
    refused = true;
  }
  if (!refused) throw new Error("a frame declaring a dictionary id was decoded anyway");
});
