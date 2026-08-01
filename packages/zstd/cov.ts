// Branch coverage for zstd's frame layer.
//
// The interesting axis is the frame header, because its descriptor byte changes the size of
// everything after it: three content-size widths, four dictionary-id widths, single-segment or
// not, checksum or not. Those combinations are hand-built rather than produced, because one
// encoder only ever emits the handful it prefers — and a decoder is judged on what it accepts,
// not on what one encoder happens to write.
//
//   deno task coverage:zstd

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");

const run = await instrument("packages/zstd/src/frame.wac");
const m = run.mod as unknown as { decompress(src: Uint8Array): Uint8Array };

function ignoringTraps(f: () => void): void {
  try {
    f();
  } catch {
    // A trap is one of the outcomes under test here, not a failure.
  }
}

/** A frame carrying one block, with the header fields spelled out rather than inferred. */
function frame(opts: {
  singleSegment?: boolean;
  fcsFlag?: number;
  contentSize?: number;
  checksum?: boolean;
  didFlag?: number;
  dictId?: number;
  windowDescriptor?: number;
  block: number[];
}): Uint8Array {
  const single = opts.singleSegment ?? true;
  const fcsFlag = opts.fcsFlag ?? 0;
  const didFlag = opts.didFlag ?? 0;
  const out: number[] = [0x28, 0xb5, 0x2f, 0xfd];
  out.push((fcsFlag << 6) | ((single ? 1 : 0) << 5) | ((opts.checksum ? 1 : 0) << 2) | didFlag);
  if (!single) out.push(opts.windowDescriptor ?? 0);
  for (let i = 0; i < [0, 1, 2, 4][didFlag]; i++) out.push((opts.dictId ?? 0) >>> (8 * i) & 0xff);
  const width = fcsFlag === 0 ? (single ? 1 : 0) : [1, 2, 4, 8][fcsFlag];
  const cs = opts.contentSize ?? 0;
  for (let i = 0; i < width; i++) out.push(Math.floor(cs / 2 ** (8 * i)) & 0xff);
  out.push(...opts.block);
  if (opts.checksum) out.push(0, 0, 0, 0);
  return new Uint8Array(out);
}

function blockHeader(type: number, size: number, last: boolean): number[] {
  const h = (size << 3) | (type << 1) | (last ? 1 : 0);
  return [h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff];
}

const raw = (bytes: number[], last = true) => [...blockHeader(0, bytes.length, last), ...bytes];
const rle = (value: number, count: number, last = true) => [...blockHeader(1, count, last), value];

// Every content-size width, including the two-byte form's 256 offset and the eight-byte one.
ignoringTraps(() => m.decompress(frame({ contentSize: 3, block: raw([1, 2, 3]) })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 1, contentSize: 3 - 256, block: raw([1, 2, 3]) })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 3, block: raw([1, 2, 3]) })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 3, contentSize: 3, block: raw([1, 2, 3]) })));

// Not single-segment, so a window descriptor is read: the smallest, a mantissa, and one past
// what an i32 window can address.
for (const wd of [0, 0x07, 0x40, 0xA0, 0xF8]) {
  ignoringTraps(() => m.decompress(frame({
    singleSegment: false, fcsFlag: 2, contentSize: 3, windowDescriptor: wd, block: raw([1, 2, 3]),
  })));
}

// Every dictionary-id width.
for (const didFlag of [0, 1, 2, 3]) {
  ignoringTraps(() => m.decompress(frame({
    fcsFlag: 2, contentSize: 3, didFlag, dictId: 0x11223344, block: raw([1, 2, 3]),
  })));
}

// A checksum field, which is stepped over until XXH64 exists.
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 3, checksum: true, block: raw([1, 2, 3]) })));

// Both plain block types, several blocks in a frame, and an empty one.
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 0, block: raw([]) })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 6, block: [...raw([1, 2, 3], false), ...raw([4, 5, 6])] })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 300, block: rle(0x61, 300) })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 300, block: [...rle(0x61, 100, false), ...raw([9, 9])] })));

// Every rejection: reserved bit, reserved block type, compressed block, oversized block, a
// block claiming more than the input holds, a wrong content size, and a truncated header.
ignoringTraps(() => m.decompress(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x28, 3, ...raw([1, 2, 3])])));
ignoringTraps(() => m.decompress(frame({ contentSize: 3, block: [...blockHeader(3, 3, true), 1, 2, 3] })));
ignoringTraps(() => m.decompress(frame({ contentSize: 3, block: [...blockHeader(2, 3, true), 1, 2, 3] })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 3, block: blockHeader(0, 200000, true) })));
ignoringTraps(() => m.decompress(frame({ fcsFlag: 2, contentSize: 3, block: blockHeader(1, 200000, true) })));
ignoringTraps(() => m.decompress(frame({ contentSize: 3, block: [...blockHeader(0, 99, true), 1, 2, 3] })));
ignoringTraps(() => m.decompress(frame({ contentSize: 9, block: raw([1, 2, 3]) })));
ignoringTraps(() => m.decompress(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd])));
ignoringTraps(() => m.decompress(new Uint8Array([0x28, 0xb5])));
ignoringTraps(() => m.decompress(new Uint8Array([0x28, 0xb5, 0x2f, 0xfe, 0, 0, 0, 0])));
ignoringTraps(() => m.decompress(new Uint8Array(0)));

// An eight-byte content size with the top bit set, which reads back as a negative i64. A
// single-segment frame takes its window from that field, so it has to be refused rather than
// used as a length.
ignoringTraps(() => m.decompress(new Uint8Array([
  0x28, 0xb5, 0x2f, 0xfd, (3 << 6) | (1 << 5),
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ...raw([1, 2, 3]),
])));

// Skippable frames: the first magic, the last, one with content, and one claiming too much.
for (const [magic, size, extra] of [
  [0x184D2A50, 4, [1, 2, 3, 4]],
  [0x184D2A5F, 0, []],
  [0x184D2A55, 99, []],
  // A size with the top bit set, which is negative read as an i32 and must not become a
  // backwards seek.
  [0x184D2A51, 0x80000000, []],
] as [number, number, number[]][]) {
  const head = [magic & 0xff, (magic >>> 8) & 0xff, (magic >>> 16) & 0xff, (magic >>> 24) & 0xff,
                size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, (size >>> 24) & 0xff];
  ignoringTraps(() => m.decompress(new Uint8Array([...head, ...extra])));
}

report([run], "packages/zstd/", { verbose });
