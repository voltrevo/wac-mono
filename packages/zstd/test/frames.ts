// Finding the FSE-coded pieces of a real zstd frame, for tests and for coverage.
//
// Header arithmetic only: this walks far enough to point at bytes, and decodes nothing. The
// point of the exercise is that the bytes came from zstd's own encoder rather than from a
// reading of the specification, so anything that interprets them has to be right.

/** Compress with Node's zstd. */
export async function zstd(text: string): Promise<Uint8Array> {
  const cmd = new Deno.Command("node", {
    args: ["-e", `const z=require("zlib");const c=[];process.stdin.on("data",d=>c.push(d)).on("end",()=>process.stdout.write(z.zstdCompressSync(Buffer.concat(c))))`],
    stdin: "piped",
    stdout: "piped",
  });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(text));
  await w.close();
  return (await child.output()).stdout;
}

/** Walk to the first compressed block's body. Header arithmetic only — nothing is decoded. */
export function firstCompressedBlock(buf: Uint8Array): { at: number; size: number } | null {
  let p = 4;
  const fhd = buf[p++];
  const fcs = fhd >> 6, single = (fhd >> 5) & 1, did = fhd & 3;
  if (!single) p++;
  p += [0, 1, 2, 4][did];
  p += fcs === 0 ? (single ? 1 : 0) : [1, 2, 4, 8][fcs];
  for (;;) {
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    const last = h & 1, type = (h >> 1) & 3, size = h >>> 3;
    const body = p + 3;
    if (type === 2) return { at: body, size };
    p = body + (type === 1 ? 1 : size);
    if (last) return null;
  }
}

/**
 * The literals section header: what kind, how big, and how many streams.
 *
 * `regen` is how many literal bytes come out and `comp` how many the section occupies; for the
 * uncompressed kinds those are the same thing. `streams` is 4 unless the section is small
 * enough that one is cheaper — the jump table costs six bytes.
 */
export type LitHeader = { type: number; fmt: number; hdr: number; regen: number; comp: number; streams: number };

export function literalsHeader(buf: Uint8Array, p: number): LitHeader {
  const b0 = buf[p];
  const type = b0 & 3, fmt = (b0 >> 2) & 3;
  if (type < 2) {
    if (fmt === 1) {
      const regen = (b0 >> 4) | (buf[p + 1] << 4);
      return { type, fmt, hdr: 2, regen, comp: type === 1 ? 1 : regen, streams: 1 };
    }
    if (fmt === 3) {
      const regen = (b0 >> 4) | (buf[p + 1] << 4) | (buf[p + 2] << 12);
      return { type, fmt, hdr: 3, regen, comp: type === 1 ? 1 : regen, streams: 1 };
    }
    const regen = b0 >> 3;
    return { type, fmt, hdr: 1, regen, comp: type === 1 ? 1 : regen, streams: 1 };
  }
  const streams = fmt === 0 ? 1 : 4;
  if (fmt === 0 || fmt === 1) {
    const v = b0 | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    return { type, fmt, hdr: 3, regen: (v >> 4) & 0x3ff, comp: (v >> 14) & 0x3ff, streams };
  }
  if (fmt === 2) {
    const v = (b0 | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0;
    return { type, fmt, hdr: 4, regen: (v >>> 4) & 0x3fff, comp: (v >>> 18) & 0x3fff, streams };
  }
  const v = b0 + buf[p + 1] * 256 + buf[p + 2] * 65536 + buf[p + 3] * 16777216 + buf[p + 4] * 4294967296;
  return { type, fmt, hdr: 5, regen: Math.floor(v / 16) % 262144, comp: Math.floor(v / 4194304) % 262144, streams };
}

/** The literals section of `text`'s first compressed block, located but not decoded. */
export async function literalsSection(
  text: string,
): Promise<{ frame: Uint8Array; at: number; head: LitHeader } | null> {
  const frame = await zstd(text);
  const blk = firstCompressedBlock(frame);
  if (blk === null) return null;
  return { frame, at: blk.at, head: literalsHeader(frame, blk.at) };
}

/** The FSE-coded Huffman weight description in `text`'s first compressed block, if it has one. */
export async function weightBytes(text: string): Promise<Uint8Array | null> {
  const frame = await zstd(text);
  const blk = firstCompressedBlock(frame);
  if (blk === null) return null;
  const lh = literalsHeader(frame, blk.at);
  if (lh.type !== 2) return null;                     // not Huffman-coded literals
  const treeAt = blk.at + lh.hdr;
  const headerByte = frame[treeAt];
  if (headerByte >= 128) return null;                 // weights written directly, not FSE-coded
  return frame.slice(treeAt + 1, treeAt + 1 + headerByte);
}

