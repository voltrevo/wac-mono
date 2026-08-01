// A wac pull loop, streamed through a worker.
//
// The property that subsumes almost everything else:
//
//   > for any input and any way of cutting it into chunks, the streamed output is byte-identical
//   > to running the same transform over the whole input at once.
//
// If that holds, *where* the chunks fall cannot matter — which is the entire risk in a streaming
// transform, and the only thing the bridge could get wrong that a single-chunk test would miss.
// `runWhole` is the oracle and runs the same wac code, so a disagreement is always the chunking.
//
// The transforms are chosen so a chunk boundary can land inside a unit: a UTF-8 scalar is up to
// four bytes, so `upperCase` has to hold a partial sequence across a read. `passthrough` is the
// control — a failure there is the bridge, not the transform.

import { runWhole, TransformFailed, wacTransformStream } from "../host/bridge.ts";

const MODULE = "packages/stream/src/transform.wac";
const enc = new TextEncoder();
const dec = new TextDecoder();

async function streamed(
  entry: string,
  chunks: Uint8Array[],
  modulePath: string = MODULE,
): Promise<Uint8Array> {
  const ts = wacTransformStream({ modulePath, entry });
  const writer = ts.writable.getWriter();
  const reading = new Response(ts.readable).arrayBuffer();
  for (const c of chunks) await writer.write(c);
  await writer.close();
  return new Uint8Array(await reading);
}

function splitAt(data: Uint8Array, points: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  for (const p of [...points, data.length]) {
    if (p > at) out.push(data.subarray(at, p));
    at = p;
  }
  return out.length > 0 ? out : [data];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

Deno.test("passthrough: the bridge moves bytes unchanged", async () => {
  const data = enc.encode("hello streaming world");
  const got = await streamed("passthrough", [data]);
  if (dec.decode(got) !== "hello streaming world") {
    throw new Error(`got ${JSON.stringify(dec.decode(got))}`);
  }
});

Deno.test("passthrough: every split of the input gives the same bytes", async () => {
  const data = enc.encode("abcdefghij");
  const whole = await runWhole({ modulePath: MODULE, entry: "passthrough" }, data);
  for (let cut = 1; cut < data.length; cut++) {
    const got = await streamed("passthrough", splitAt(data, [cut]));
    if (!bytesEqual(got, whole)) {
      throw new Error(`split at ${cut}: ${JSON.stringify(dec.decode(got))}`);
    }
  }
});

Deno.test("upperCase: a scalar split across chunks survives", async () => {
  // The case the whole design is about. `é` is two bytes and `😀` is four, so a cut inside one
  // must be held rather than decoded — and must not be emitted twice when the rest arrives.
  const text = "café 日本 😀 done";
  const data = enc.encode(text);
  const whole = await runWhole({ modulePath: MODULE, entry: "upperCase" }, data);
  if (dec.decode(whole) !== text.toUpperCase()) {
    throw new Error(`whole-input result is already wrong: ${JSON.stringify(dec.decode(whole))}`);
  }

  for (let cut = 1; cut < data.length; cut++) {
    const got = await streamed("upperCase", splitAt(data, [cut]));
    if (!bytesEqual(got, whole)) {
      throw new Error(
        `split at byte ${cut} of ${data.length}: got ${JSON.stringify(dec.decode(got))}, want ${JSON.stringify(dec.decode(whole))}`,
      );
    }
  }
});

Deno.test("upperCase: byte at a time, which is every boundary at once", async () => {
  const data = enc.encode("héllo 世界 🎉");
  const whole = await runWhole({ modulePath: MODULE, entry: "upperCase" }, data);
  const chunks = Array.from(data, b => new Uint8Array([b]));
  const got = await streamed("upperCase", chunks);
  if (!bytesEqual(got, whole)) {
    throw new Error(`one byte at a time: ${JSON.stringify(dec.decode(got))}`);
  }
});

Deno.test("more data than the ring holds, so both sides block", async () => {
  // The rings are 64 KiB. A megabyte forces the producer to wait for space and the transform to
  // wait for the consumer — the back-pressure paths, which no small input reaches.
  const unit = enc.encode("the quick brown fox jumps over the lazy dog. ");
  const parts: Uint8Array[] = [];
  let total = 0;
  while (total < 1 << 20) {
    parts.push(unit);
    total += unit.length;
  }
  const data = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    data.set(p, at);
    at += p.length;
  }

  const got = await streamed("upperCase", parts);
  const want = enc.encode(dec.decode(data).toUpperCase());
  if (!bytesEqual(got, want)) {
    throw new Error(`1 MiB through a 64 KiB ring: ${got.length} bytes out, want ${want.length}`);
  }
});

Deno.test("output arrives before the input is finished", async () => {
  // Otherwise this is a buffering wrapper wearing a stream's clothes. The reader must see bytes
  // while the writer is still writing.
  const ts = wacTransformStream({ modulePath: MODULE, entry: "passthrough" });
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();

  await writer.write(enc.encode("first"));
  const early = await reader.read();
  if (early.done || dec.decode(early.value) !== "first") {
    throw new Error(`nothing came out before the input ended: ${JSON.stringify(early)}`);
  }

  await writer.write(enc.encode("second"));
  const next = await reader.read();
  if (next.done || dec.decode(next.value) !== "second") {
    throw new Error(`second chunk: ${JSON.stringify(next)}`);
  }
  await writer.close();
  await reader.cancel();
});

Deno.test("an empty input is an empty output, not a hang", async () => {
  const got = await streamed("passthrough", []);
  if (got.length !== 0) throw new Error(`${got.length} bytes from no input`);
});

Deno.test("a transform that rejects its input errors the stream", async () => {
  // `upperCase` returns -1 for bytes that are not UTF-8. That has to reach the consumer as a
  // failed stream — a transform that fails silently is worse than one that throws.
  const ts = wacTransformStream({ modulePath: MODULE, entry: "upperCase" });
  const writer = ts.writable.getWriter();
  const reading = new Response(ts.readable).arrayBuffer();
  await writer.write(new Uint8Array([0xff, 0xfe]));
  await writer.close();
  let failed = false;
  try {
    await reading;
  } catch (e) {
    failed = e instanceof TransformFailed || String(e).includes("transform");
  }
  if (!failed) throw new Error("invalid UTF-8 did not fail the stream");
});

Deno.test("a truncated scalar at end of input is a failure, not silent truncation", async () => {
  // The other half of holding a partial sequence: if the input ends mid-scalar, the held bytes are
  // not text and must not be quietly dropped.
  const ts = wacTransformStream({ modulePath: MODULE, entry: "upperCase" });
  const writer = ts.writable.getWriter();
  const reading = new Response(ts.readable).arrayBuffer();
  await writer.write(enc.encode("ok").slice());
  await writer.write(new Uint8Array([0xf0, 0x9f]));    // the first half of an emoji
  await writer.close();
  let failed = false;
  try {
    await reading;
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("a truncated scalar was accepted");
});

Deno.test("a consumer that stops reading stops the producer", {
  // The claim the readable/writable pair exists to support, and the one a `TransformStream` could
  // not make: with nobody reading, the transform blocks on a full output ring, the input ring then
  // fills, and the *writer* stops. Without it this would buffer the whole input in memory.
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const ts = wacTransformStream({ modulePath: MODULE, entry: "passthrough" });
  const writer = ts.writable.getWriter();

  const CAP = 1 << 16;                         // must match host/layout.ts
  const chunk = new Uint8Array(4096).fill(0x61);
  let written = 0;
  const stalled = Symbol("stalled");

  // No reader at all. Write until a write stops completing.
  for (let i = 0; i < 200; i++) {
    const race = await Promise.race([
      writer.write(chunk).then(() => "wrote"),
      new Promise(r => setTimeout(() => r(stalled), 250)),
    ]);
    if (race === stalled) break;
    written += chunk.length;
  }

  // What is in flight when everything is full: the input ring, the chunk the transform is holding
  // between its read and its write, the output ring, and the writable's own queue. That is around
  // four rings, and it drifts by a few chunks between runs depending on where the worker is when
  // the writer stalls — so the assertion is the bound, not the figure. 320 KiB against the 800 KiB
  // offered is the difference between bounded and buffering-the-lot.
  const ceiling = 5 * CAP;
  if (written > ceiling) {
    throw new Error(`absorbed ${written} bytes with nobody reading; expected to stall by ${ceiling}`);
  }
  if (written === 0) throw new Error("stalled before accepting anything at all");

  await ts.readable.cancel();
});

Deno.test("it is a stream, so it composes with pipeThrough", async () => {
  const source = new Blob([enc.encode("piped through wac")]).stream();
  const out = source.pipeThrough(wacTransformStream({ modulePath: MODULE, entry: "upperCase" }));
  const got = new Uint8Array(await new Response(out).arrayBuffer());
  if (dec.decode(got) !== "PIPED THROUGH WAC") throw new Error(dec.decode(got));
});

Deno.test("gunzip through the bridge, which is what the whole thing was for", async () => {
  // `packages/gzip` exports `gunzipStream` in exactly the shape this bridge drives, so a gzip
  // file becomes a `DecompressionStream` with no glue between them. Nothing here knows it is
  // gzip: `modulePath` and `entry` are the only difference from `upperCase` above.
  const GZIP = "packages/gzip/src/inflate.wac";
  const unit = enc.encode("streaming all the way down. ");
  const data = new Uint8Array(unit.length * 9000);
  for (let i = 0; i < 9000; i++) data.set(unit, i * unit.length);

  const cmd = new Deno.Command("python3", {
    args: ["-c", "import sys,gzip; sys.stdout.buffer.write(gzip.compress(sys.stdin.buffer.read(), 6))"],
    stdin: "piped",
    stdout: "piped",
  });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(data);
  await w.close();
  const gz = (await child.output()).stdout;

  // Fed in small pieces, so the decoder blocks on input repeatedly rather than seeing it whole.
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < gz.length; i += 1000) chunks.push(gz.slice(i, i + 1000));

  const got = await streamed("gunzipStream", chunks, GZIP);
  if (!bytesEqual(got, data)) {
    throw new Error(`${got.length} bytes out of the bridge, want ${data.length}`);
  }
});

Deno.test("gzip through the bridge, so both directions stream", async () => {
  // The compressing half. Judged by the system `gunzip` rather than by our own decoder: a
  // compressor that only agrees with its own reader has proved nothing.
  const GZIP = "packages/gzip/src/gzip.wac";
  const unit = enc.encode("compressed on the way out. ");
  const data = new Uint8Array(unit.length * 9000);
  for (let i = 0; i < 9000; i++) data.set(unit, i * unit.length);

  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += 4096) chunks.push(data.subarray(i, i + 4096));
  const gz = await streamed("gzipStream", chunks, GZIP);
  if (gz.length >= data.length) throw new Error(`${gz.length} bytes out for ${data.length} in`);

  const cmd = new Deno.Command("gunzip", { args: ["-c"], stdin: "piped", stdout: "piped", stderr: "piped" });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(gz);
  await w.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) throw new Error(`gunzip rejected it: ${dec.decode(stderr)}`);
  if (!bytesEqual(stdout, data)) throw new Error(`gunzip gave back ${stdout.length} bytes`);
});

Deno.test("compress then decompress, as two piped wac streams", async () => {
  // Both halves composed with `pipeThrough`, which is the shape the whole exercise was for.
  const data = enc.encode("through wac and back again. ".repeat(4000));
  const source = new Blob([data]).stream();
  const out = source
    .pipeThrough(wacTransformStream({ modulePath: "packages/gzip/src/gzip.wac", entry: "gzipStream" }))
    .pipeThrough(wacTransformStream({ modulePath: "packages/gzip/src/inflate.wac", entry: "gunzipStream" }));
  const got = new Uint8Array(await new Response(out).arrayBuffer());
  if (!bytesEqual(got, data)) throw new Error(`${got.length} bytes back, want ${data.length}`);
});
