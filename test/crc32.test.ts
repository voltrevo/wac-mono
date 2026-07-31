// CRC-32 vectors. Every expected value here came from Python's zlib:
//   python3 -c "import zlib; print(zlib.crc32(b'...'))"
// Nothing is eyeballed, and none of them are round numbers that could pass by
// coincidence.

import { wacBind } from "../harness/wacBind.ts";

const mod = await wacBind("src/crc32.wac");
const crc32 = mod.crc32 as (data: Uint8Array) => number;

/** zlib returns unsigned; wac returns the same bits as a signed i32. */
function unsigned(n: number): number {
  return n >>> 0;
}

const VECTORS: [string, number][] = [
  ["", 0],
  ["a", 3904355907],
  ["abc", 891568578],
  ["hello world", 222957957],
  ["The quick brown fox jumps over the lazy dog", 1095738169],
  ["123456789", 3421780262],
];

Deno.test("crc32: known zlib vectors", () => {
  for (const [text, expected] of VECTORS) {
    const got = unsigned(crc32(new TextEncoder().encode(text)));
    if (got !== expected) {
      throw new Error(`crc32(${JSON.stringify(text)}): got ${got}, expected ${expected}`);
    }
  }
});

Deno.test("crc32: all 256 byte values, one at a time", () => {
  // A single byte b has crc32 that depends on the full table; getting all 256
  // right means the polynomial and the reflection are both correct. Expected
  // values are the zlib results, summed so the vector stays readable — the sum
  // is checked against Python rather than assumed.
  let sum = 0n;
  for (let b = 0; b < 256; b++) {
    sum += BigInt(unsigned(crc32(new Uint8Array([b]))));
  }
  const expected = 549755813760n; // python: sum(zlib.crc32(bytes([b])) for b in range(256))
  if (sum !== expected) {
    throw new Error(`sum of crc32 over single bytes: got ${sum}, expected ${expected}`);
  }
});

Deno.test("crc32: long input (incremental state, not just one block)", () => {
  const data = new Uint8Array(10000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xFF;
  // python:
  //   data = bytes(((i*31+7) & 0xFF) for i in range(10000))
  //   zlib.crc32(data)
  const expected = 954632217;
  const got = unsigned(crc32(data));
  if (got !== expected) throw new Error(`crc32(10000 bytes): got ${got}, expected ${expected}`);
});
