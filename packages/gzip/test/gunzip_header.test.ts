// The gzip header's optional fields.
//
// `gzipBest` and friends always write FLG=0 — no filename, no comment, no extra field,
// no header CRC — so almost every stream the suite decompressed was one this repo
// produced, with a fixed ten-byte header.
//
// FNAME is the exception and was already covered: `inflate.test.ts` compresses with the
// gzip CLI, which stores the original filename, and asserts FLG has the bit set so the
// test cannot quietly stop covering it. FCOMMENT, FEXTRA and FHCRC had nothing. So did
// the combinations — the fields have a fixed order and each one moves the offset the
// next is read from, which is precisely the arithmetic that a single-field test cannot
// check — and so did the boundaries, an empty name being the one that decides whether
// the skip loop lands on the payload or one byte short of it.
//
// The python case here is a second, independent source of FNAME bytes rather than the
// first: two encoders agreeing is worth more than one, and it runs without needing the
// gzip CLI on the path. Everything else is hand-spliced onto a payload our own
// compressor produced, so a failure is in the header parsing and not downstream.

import { wacBind } from "../../../harness/wacBind.ts";

const inflateMod = await wacBind("packages/gzip/src/inflate.wac");
const gunzipBytes = inflateMod.gunzipBytes as (gz: Uint8Array) => Uint8Array;

const gzipMod = await wacBind("packages/gzip/src/gzip.wac");
const gzipBest = gzipMod.gzipBest as (data: Uint8Array) => Uint8Array;

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Rebuild a stream with `flg` set and `fields` spliced in after the fixed header.
 *
 * The payload and trailer are taken from a stream our compressor made, so only the
 * header differs from something already known to round-trip. FLG is part of no
 * checksum — the CRC covers the uncompressed data and FHCRC only the header — so this
 * produces a stream a conforming decoder must accept.
 */
function withHeaderFields(payload: Uint8Array, flg: number, fields: number[]): Uint8Array {
  const base = gzipBest(payload);
  return new Uint8Array([
    base[0], base[1], base[2], flg, base[4], base[5], base[6], base[7], base[8], base[9],
    ...fields,
    ...base.subarray(10),
  ]);
}

const FEXTRA = 4, FNAME = 8, FCOMMENT = 16, FHCRC = 2;

/** A NUL-terminated string, as FNAME and FCOMMENT are stored. */
const cstr = (s: string) => [...enc.encode(s), 0];

function roundTrips(name: string, gz: Uint8Array, want: string): void {
  let got: string;
  try {
    got = dec.decode(gunzipBytes(gz));
  } catch (e) {
    throw new Error(`${name}: rejected a valid stream — ${(e as Error).message}`);
  }
  if (got !== want) throw new Error(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

Deno.test("gunzip: a stream carrying a filename, as produced by python", async () => {
  // Real bytes rather than a splice. inflate.test.ts already does this with the gzip
  // CLI; python is a different encoder reaching the same path, and needs nothing on the
  // PATH beyond python itself.
  const text = "the most common gzip header in the world\n".repeat(4);
  const cmd = new Deno.Command("python3", {
    args: ["-c", `
import gzip, io, sys
buf = io.BytesIO()
with gzip.GzipFile(filename="report.txt", mode="wb", fileobj=buf, mtime=0) as f:
    f.write(sys.stdin.buffer.read())
sys.stdout.buffer.write(buf.getvalue())
`],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(enc.encode(text));
  await w.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) throw new Error(`python failed: ${dec.decode(stderr)}`);

  const gz = new Uint8Array(stdout);
  if ((gz[3] & FNAME) === 0) {
    throw new Error(`python did not set FNAME; FLG=${gz[3]} — the test would prove nothing`);
  }
  roundTrips("python FNAME", gz, text);
});

Deno.test("gunzip: every combination of the optional header fields", () => {
  const text = "optional header fields\n".repeat(8);
  const name = cstr("archive.tar");
  const comment = cstr("written by hand");
  // FEXTRA is a two-byte length followed by that many bytes.
  const extra = [4, 0, 0x41, 0x42, 0x43, 0x44];
  // FHCRC is two bytes. gunzipBytes skips rather than verifies it, which is within
  // spec — the field is optional to check — so the value here only has to be skipped.
  const hcrc = [0x12, 0x34];

  const cases: [string, number, number[]][] = [
    ["FNAME", FNAME, name],
    ["FCOMMENT", FCOMMENT, comment],
    ["FEXTRA", FEXTRA, extra],
    ["FHCRC", FHCRC, hcrc],
    ["FNAME + FCOMMENT", FNAME | FCOMMENT, [...name, ...comment]],
    ["FEXTRA + FNAME", FEXTRA | FNAME, [...extra, ...name]],
    // Order matters and is fixed by the format: FEXTRA, FNAME, FCOMMENT, FHCRC.
    ["all four", FEXTRA | FNAME | FCOMMENT | FHCRC, [...extra, ...name, ...comment, ...hcrc]],
  ];
  for (const [label, flg, fields] of cases) {
    roundTrips(label, withHeaderFields(enc.encode(text), flg, fields), text);
  }
});

Deno.test("gunzip: empty and single-character names and comments", () => {
  // A name that is just its terminator is the boundary of the skip loop — it must
  // advance past the NUL and no further. An off-by-one here shifts the whole payload.
  const text = "boundary\n";
  const cases: [string, number, number[]][] = [
    ["empty name", FNAME, cstr("")],
    ["one-character name", FNAME, cstr("a")],
    ["empty comment", FCOMMENT, cstr("")],
    ["empty name and empty comment", FNAME | FCOMMENT, [...cstr(""), ...cstr("")]],
    ["empty FEXTRA", FEXTRA, [0, 0]],
  ];
  for (const [label, flg, fields] of cases) {
    roundTrips(label, withHeaderFields(enc.encode(text), flg, fields), text);
  }
});

Deno.test("gunzip: a name with no terminator before the end of input", () => {
  // The skip loop is bounded by the input length as well as by the NUL, so a truncated
  // name runs off the end. What must not happen is reading past the buffer; the stream
  // is malformed either way, so a trap is the only correct outcome.
  const base = gzipBest(enc.encode("truncated name"));
  const noNul = new Uint8Array([
    base[0], base[1], base[2], FNAME, base[4], base[5], base[6], base[7], base[8], base[9],
    ...enc.encode("name-with-no-terminator-at-all-running-to-the-very-end"),
  ]);
  let threw = false;
  try {
    gunzipBytes(noNul);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("a filename with no terminator was accepted");
});
