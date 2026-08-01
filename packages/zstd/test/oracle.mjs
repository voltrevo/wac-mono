// A zstd encoder to test the decoder against.
//
// Node's zlib carries zstd (22.15+), which makes this a real oracle rather than a second
// implementation of the same misreading: the frames below are produced by the reference
// encoder, so a disagreement is ours.
//
// Reads a JSON job on stdin, writes JSON on stdout. A subprocess per test run rather than per
// case — spawning is the slow part.

import zlib from "node:zlib";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const jobs = JSON.parse(Buffer.concat(chunks).toString());

const out = jobs.map(job => {
  // A decode job goes the other way: hand this frame to the reference decoder and report what
  // it makes of it. That is how a hand-built frame gets checked by something other than us.
  if (job.decode !== undefined) {
    try {
      return { data: zlib.zstdDecompressSync(Buffer.from(job.decode, "base64")).toString("base64") };
    } catch (e) {
      return { error: String(e.message ?? e) };
    }
  }
  const data = Buffer.from(job.data, "base64");
  const params = {};
  if (job.level !== undefined) params[zlib.constants.ZSTD_c_compressionLevel] = job.level;
  if (job.checksum) params[zlib.constants.ZSTD_c_checksumFlag] = 1;
  const frame = zlib.zstdCompressSync(data, { params });
  return { frame: frame.toString("base64"), blocks: blockTypes(frame) };
});
process.stdout.write(JSON.stringify(out));

/** Walk the frame and name each block's type, so a test can say what it is actually covering. */
function blockTypes(buf) {
  let p = 4;
  const fhd = buf[p++];
  const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, didFlag = fhd & 3;
  if (!single) p++;
  p += [0, 1, 2, 4][didFlag];
  p += fcsFlag === 0 ? (single ? 1 : 0) : [1, 2, 4, 8][fcsFlag];
  const types = [];
  for (;;) {
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    const last = h & 1, type = (h >> 1) & 3, size = h >>> 3;
    types.push(["raw", "rle", "compressed", "reserved"][type]);
    p += 3 + (type === 1 ? 1 : size);
    if (last) break;
  }
  return types;
}
