// Decompressor tests.
//
// The encoder is verified by an external decompressor; the decoder has to be
// verified by an external *compressor*, or the two halves could agree on the
// same misreading of the format. So the primary tests here inflate streams
// produced by python's gzip and by the gzip CLI, across levels — level 0 emits
// stored blocks, 1 and 6 and 9 emit dynamic ones with different tree shapes.
//
// A decompressor also has an obligation the compressor does not: its input is
// untrusted. Corrupt streams must trap, not read out of bounds or spin.

import { wacBind } from "../../../harness/wacBind.ts";
import { bytesEqual, pythonGzip } from "./util.ts";

const inflateMod = await wacBind("packages/gzip/src/inflate.wac");
const gunzipBytes = inflateMod.gunzipBytes as (gz: Uint8Array) => Uint8Array;
const inflateRaw = inflateMod.inflate as (data: Uint8Array) => Uint8Array;

const gzipMod = await wacBind("packages/gzip/src/gzip.wac");
const gzipStored = gzipMod.gzipStored as (d: Uint8Array) => Uint8Array;
const gzipFixed = gzipMod.gzipFixed as (d: Uint8Array) => Uint8Array;
const gzipDynamic = gzipMod.gzipDynamic as (d: Uint8Array) => Uint8Array;
const gzipBest = gzipMod.gzipBest as (d: Uint8Array) => Uint8Array;

const enc = new TextEncoder();

function prng(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7FFFFFFF;
    out[i] = (s >>> 16) & 0xFF;
  }
  return out;
}

const SAMPLES: [string, Uint8Array][] = [
  ["empty", new Uint8Array(0)],
  ["one byte", new Uint8Array([7])],
  ["hello world", enc.encode("hello world")],
  ["all 256 values", Uint8Array.from({ length: 256 }, (_, i) => i)],
  ["5000 zeros", new Uint8Array(5000)],
  ["prose", enc.encode("DEFLATE is a lossless compressed data format. ".repeat(200))],
  ["incompressible", prng(20000, 4242)],
  ["structured", Uint8Array.from({ length: 60000 }, (_, i) => (i % 251) & 0xFF)],
];

Deno.test("inflate: python gzip output, levels 0 through 9", async () => {
  for (const [name, data] of SAMPLES) {
    for (const level of [0, 1, 2, 6, 9]) {
      const gz = await pythonGzip(data, level);
      const out = gunzipBytes(gz);
      const diff = bytesEqual(out, data);
      if (diff !== -1) {
        throw new Error(`${name} @level ${level}: ` +
          (diff === -2 ? `length ${out.length}, expected ${data.length}` : `byte ${diff} differs`));
      }
    }
  }
});

Deno.test("inflate: gzip CLI output, including the FNAME header field", async () => {
  // The CLI stores the original filename, so this is the only test that
  // exercises the FNAME skip in the header parser.
  const data = enc.encode("filename header check ".repeat(100));
  const dir = await Deno.makeTempDir();
  const path = `${dir}/payload.txt`;
  await Deno.writeFile(path, data);
  const cmd = new Deno.Command("gzip", { args: ["-9", path] });
  const { code, stderr } = await cmd.output();
  if (code !== 0) throw new Error(`gzip failed: ${new TextDecoder().decode(stderr)}`);
  const gz = await Deno.readFile(`${path}.gz`);
  await Deno.remove(dir, { recursive: true });

  if ((gz[3] & 8) === 0) {
    throw new Error("expected the gzip CLI to set FNAME; this test is not covering it");
  }
  const out = gunzipBytes(gz);
  if (bytesEqual(out, data) !== -1) throw new Error("FNAME stream did not inflate correctly");
});

Deno.test("inflate: round trips this compressor's own output", async () => {
  // Closing the loop. Not a substitute for the external checks above — both
  // halves could share a misreading — but it does catch asymmetries.
  const modes: [string, (d: Uint8Array) => Uint8Array][] = [
    ["stored", gzipStored],
    ["fixed", gzipFixed],
    ["dynamic", gzipDynamic],
    ["best", gzipBest],
  ];
  for (const [mode, fn] of modes) {
    for (const [name, data] of SAMPLES) {
      const out = gunzipBytes(fn(data));
      const diff = bytesEqual(out, data);
      if (diff !== -1) {
        throw new Error(`${mode}/${name}: ` +
          (diff === -2 ? `length ${out.length}, expected ${data.length}` : `byte ${diff} differs`));
      }
    }
  }
});

Deno.test("inflate: overlapping matches decode byte by byte", () => {
  // Distance 1 with a long length means the copy reads bytes it is writing. A
  // decoder using a bulk copy produces the wrong bytes here while still
  // producing the right *number* of them.
  for (const n of [3, 4, 258, 259, 1000, 5000]) {
    const data = new Uint8Array(n).fill(0x7E);
    const out = gunzipBytes(gzipFixed(data));
    if (bytesEqual(out, data) !== -1) throw new Error(`${n} identical bytes failed`);
  }
  const ab = enc.encode("ab".repeat(3000));
  if (bytesEqual(gunzipBytes(gzipFixed(ab)), ab) !== -1) throw new Error("ab-repeat failed");
});

Deno.test("inflate: raw deflate streams without the gzip wrapper", async () => {
  // python's zlib with wbits=-15 emits a bare deflate stream.
  const data = enc.encode("raw deflate stream ".repeat(50));
  const cmd = new Deno.Command("python3", {
    args: ["-c", "import sys,zlib; c=zlib.compressobj(6,zlib.DEFLATED,-15); sys.stdout.buffer.write(c.compress(sys.stdin.buffer.read())+c.flush())"],
    stdin: "piped", stdout: "piped", stderr: "piped",
  });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(data);
  await w.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) throw new Error(`python zlib failed: ${new TextDecoder().decode(stderr)}`);

  const out = inflateRaw(stdout);
  if (bytesEqual(out, data) !== -1) throw new Error("raw deflate stream did not inflate correctly");
});

Deno.test("inflate: corrupt input traps rather than misbehaving", async () => {
  const good = await pythonGzip(enc.encode("corruption tests ".repeat(50)), 6);

  function mustTrap(name: string, gz: Uint8Array) {
    let threw = false;
    try {
      gunzipBytes(gz);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`${name}: expected a trap, but it returned normally`);
  }

  mustTrap("empty input", new Uint8Array(0));
  mustTrap("too short", new Uint8Array([0x1F, 0x8B, 8]));

  const badMagic = good.slice();
  badMagic[0] = 0x1E;
  mustTrap("bad magic", badMagic);

  const badMethod = good.slice();
  badMethod[2] = 7;   // CM must be 8
  mustTrap("bad compression method", badMethod);

  mustTrap("truncated body", good.slice(0, good.length - 20));

  const badCrc = good.slice();
  badCrc[good.length - 8] ^= 0xFF;
  mustTrap("wrong CRC-32", badCrc);

  const badSize = good.slice();
  badSize[good.length - 4] ^= 0xFF;
  mustTrap("wrong ISIZE", badSize);

  // BTYPE 11 is reserved. Byte 10 is the first payload byte: keep BFINAL, set
  // BTYPE to 3.
  const badType = good.slice();
  badType[10] = (badType[10] & 0xF8) | 0x07;
  mustTrap("reserved BTYPE 11", badType);

  // Stored block whose NLEN is not the complement of LEN.
  const stored = gzipStored(enc.encode("stored block"));
  const badNlen = stored.slice();
  badNlen[13] ^= 0xFF;   // header(10) + block header(1) + LEN(2) -> NLEN at 13
  mustTrap("stored block with bad NLEN", badNlen);

  // Garbage in the middle of the compressed body.
  const scrambled = good.slice();
  for (let i = 14; i < Math.min(30, scrambled.length - 8); i++) scrambled[i] ^= 0x5A;
  mustTrap("scrambled body", scrambled);
});

Deno.test("inflate: multi-member streams are rejected, not silently truncated", async () => {
  // Concatenated gzip members are legal and this reader handles only the first.
  // The trailer check catches it, so the failure is loud — which is the point:
  // returning just the first member's bytes would look like success.
  const a = await pythonGzip(enc.encode("first member"), 6);
  const b = await pythonGzip(enc.encode("second member"), 6);
  const both = new Uint8Array(a.length + b.length);
  both.set(a, 0);
  both.set(b, a.length);
  let threw = false;
  try {
    gunzipBytes(both);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected a multi-member stream to trap");
});

Deno.test("inflate: multi-block streams from a large input", async () => {
  // zlib emits several blocks for input this size, so the loop over BFINAL is
  // exercised rather than only ever seeing one final block.
  const data = new Uint8Array(400000);
  let s = 88;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7FFFFFFF;
    data[i] = i % 1013 === 0 ? (s >>> 16) & 0xFF : (i % 131) & 0xFF;
  }
  for (const level of [1, 6, 9]) {
    const out = gunzipBytes(await pythonGzip(data, level));
    if (bytesEqual(out, data) !== -1) throw new Error(`level ${level}: 400000-byte stream failed`);
  }
});
