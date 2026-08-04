// Branch coverage for stream.
//
// No worker here. The wac side does not know whether its `read` blocks, so the branches are all
// reachable by driving the same exports with synchronous callbacks — which is also `runWhole`.
// What the worker adds is *when* the bytes arrive, and that is the tests' job, not coverage's.
//
// The interesting axis is therefore chunking: the held-partial-scalar paths in `upperCase` are only
// entered when a read returns a fragment of a sequence, so every input is driven at several chunk
// sizes, including one byte at a time.
//
//   deno task coverage:stream
//   deno task coverage:stream --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");
const enc = new TextEncoder();

const run = await instrument("packages/stream/src/transform.wac");
const modRead = run.mod.Read as { Data(b: Uint8Array): unknown; End(): unknown };
const m = run.mod as unknown as {
  passthrough(read: () => unknown, write: (b: Uint8Array) => boolean): number;
  Read: { Data(bytes: Uint8Array): unknown; End(): unknown; Failed(why: string): unknown };
  upperCase(read: () => unknown, write: (b: Uint8Array) => boolean): number;
};

// One reader and one writer for the whole run, not a closure per call: bindgen keeps 16 slots per
// callback signature and never frees one, so fresh closures run out almost immediately.
let src: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
let at = 0;
let step = 1;
let accept = true;

function read(): unknown {
  const n = Math.min(step, src.length - at);
  if (n === 0) return modRead.End();
  const chunk = src.subarray(at, at + n);
  at += n;
  return modRead.Data(chunk);
}

function write(): boolean {
  return accept;
}

/** Drive an entry over `input` handed out `size` bytes at a time. */
function drive(entry: "passthrough" | "upperCase", input: Uint8Array, size: number): number {
  src = input;
  at = 0;
  step = size;
  accept = true;
  return m[entry](read, write);
}

/** The same, with a sink that refuses everything. */
function driveRefusing(entry: "passthrough" | "upperCase", input: Uint8Array): number {
  src = input;
  at = 0;
  step = 1 << 20;
  accept = false;
  return m[entry](read, write);
}

const TEXTS = [
  "", "a", "abc", "ABC", "hello world",
  "café", "日本語", "\u{1f600}\u{1f601}", "ΣΊΣΥΦΟΣ", "σίσυφος",
  "straße", "İstanbul", "\u{10ffff}",
  // Every encoded length adjacent to every other, so a cut can fall between any two widths.
  "a\u{80}\u{800}\u{10000}a", "\u{10000}\u{800}\u{80}a",
];

for (const text of TEXTS) {
  const bytes = enc.encode(text);
  // 1 exercises the held-fragment path at every position; a size past the end is the
  // whole-input-in-one-read case; the middle sizes land inside sequences of each width.
  for (const size of [1, 2, 3, 4, 5, 7, 64, 1 << 20]) {
    drive("passthrough", bytes, size);
    drive("upperCase", bytes, size);
  }
}

/** Malformed input: the rejection paths, and a truncation held at end of input. */
for (
  const bytes of [
    [0xff], [0xfe], [0x80], [0xbf], [0xc0, 0x80], [0xc2], [0xe0, 0xa0], [0xf0, 0x9f, 0x98],
    [0xed, 0xa0, 0x80], [0xf5, 0x80, 0x80, 0x80], [0x61, 0xff, 0x62], [0xf0, 0x9f],
    [0x41, 0xc2], [0xe0, 0x80, 0x80],
  ]
) {
  const arr = new Uint8Array(bytes);
  for (const size of [1, 2, 1 << 20]) {
    drive("passthrough", arr, size);
    drive("upperCase", arr, size);
  }
}

/** A write sink that refuses, which is the other way a transform can stop early. */
driveRefusing("upperCase", enc.encode("refused"));
driveRefusing("passthrough", enc.encode("refused"));

/** Enough data that the loop runs many times rather than once. */
const big = enc.encode("The Quick Brown Fox. ".repeat(4000));
drive("upperCase", big, 4096);
drive("passthrough", big, 4096);

report([run], "packages/stream/", { verbose });
