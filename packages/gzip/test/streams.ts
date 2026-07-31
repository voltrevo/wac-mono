// Hand-built DEFLATE streams, for reaching decoder paths no valid input reaches.
//
// Random corruption does not get here. A flipped bit in a Huffman-coded stream almost
// always breaks the symbol decode first, so the stream dies long before a distance is
// validated or a code-length run overruns its table. Mutation testing found that hole
// first — deleting inflate's "distance points before the start of output" check failed
// no test at all — and the answer is streams assembled on purpose, bit by bit.
//
// Extracted from inflate_adversarial.test.ts so that cov.ts can drive the same streams
// the tests assert on. If the two drifted apart, the coverage report would describe a
// workload nobody checks.

/** LSB-first bit writer, mirroring src/bitwriter.wac. */
export class Bits {
  private bytes: number[] = [];
  private buf = 0;
  private count = 0;

  /** Data elements: least significant bit first. */
  bits(value: number, n: number): this {
    for (let i = 0; i < n; i++) {
      this.buf |= ((value >>> i) & 1) << this.count;
      if (++this.count === 8) {
        this.bytes.push(this.buf & 0xFF);
        this.buf = 0;
        this.count = 0;
      }
    }
    return this;
  }

  /** Huffman codes: most significant bit of the code first. */
  code(value: number, n: number): this {
    for (let i = n - 1; i >= 0; i--) this.bits((value >>> i) & 1, 1);
    return this;
  }

  /** A literal byte under the fixed literal/length code. */
  literal(byte: number): this {
    return byte <= 143 ? this.code(0x30 + byte, 8) : this.code(0x190 + (byte - 144), 9);
  }

  /** A literal/length symbol under the fixed code. */
  litLenSymbol(sym: number): this {
    if (sym <= 143) return this.code(0x30 + sym, 8);
    if (sym <= 255) return this.code(0x190 + (sym - 144), 9);
    if (sym <= 279) return this.code(sym - 256, 7);
    return this.code(0xC0 + (sym - 280), 8);
  }

  done(): Uint8Array {
    if (this.count > 0) this.bytes.push(this.buf & 0xFF);
    return new Uint8Array(this.bytes);
  }
}

/** BFINAL=1, BTYPE=01 (fixed Huffman). */
export function fixedBlock(): Bits {
  return new Bits().bits(1, 1).bits(1, 2);
}

/** BFINAL=1, BTYPE=00 (stored). The caller supplies LEN, NLEN and the bytes. */
export function storedBlock(): Bits {
  return new Bits().bits(1, 1).bits(0, 2);
}

/** The code-length code order from RFC 1951 §3.2.7 — must match inflate's CL_ORDER. */
export const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/**
 * Canonical Huffman codes for a set of code lengths, per RFC 1951 §3.2.2.
 *
 * Written out rather than borrowed from src/huffman.wac, because a builder that shares
 * the decoder's own code-assignment logic would agree with it by construction and prove
 * nothing about whether that logic is right.
 */
export function canonical(lengths: number[]): Map<number, { code: number; len: number }> {
  const maxLen = Math.max(0, ...lengths);
  const countByLen = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l > 0) countByLen[l]++;

  const firstCode = new Array(maxLen + 2).fill(0);
  let code = 0;
  for (let l = 1; l <= maxLen; l++) {
    code = (code + countByLen[l - 1]) << 1;
    firstCode[l] = code;
  }

  const next = firstCode.slice();
  const out = new Map<number, { code: number; len: number }>();
  // Within one length, codes go to symbols in increasing symbol order.
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym];
    if (len > 0) out.set(sym, { code: next[len]++, len });
  }
  return out;
}

/**
 * One instruction in the run-length-encoded code-length sequence.
 *
 * `sym` 0..15 is a code length written literally and takes no `extra`. 16 repeats the
 * previous length `extra + 3` times, 17 writes `extra + 3` zeros, and 18 writes
 * `extra + 11` zeros — the widths of those three extra fields differ (2, 3 and 7 bits),
 * which is why `dynamicHeader` switches on the symbol rather than taking a width.
 */
export type ClOp = { sym: number; extra?: number };

/** Extra-bit width for each run symbol, and 0 for a literal length. */
const EXTRA_BITS: Record<number, number> = { 16: 2, 17: 3, 18: 7 };

/**
 * A dynamic (BTYPE=10) block header.
 *
 * `clLengths` is the 19-entry code-length code, indexed by symbol — *not* in the
 * transmitted permuted order; this function applies CL_ORDER itself. `hclen` says how
 * many of those permuted entries to send, which is deliberately separate so a caller
 * can send fewer than the lengths it supplies.
 *
 * `ops` is emitted with that code, so a caller can write a sequence that is malformed
 * in a specific way — a repeat with nothing before it, a run that overruns the table —
 * which is the whole point of building this by hand.
 */
export function dynamicHeader(opts: {
  hlit: number;
  hdist: number;
  clLengths: number[];
  ops: ClOp[];
  hclen?: number;
  bfinal?: boolean;
}): Bits {
  const { hlit, hdist, clLengths, ops } = opts;
  const hclen = opts.hclen ?? 19;
  const b = new Bits().bits(opts.bfinal === false ? 0 : 1, 1).bits(2, 2);

  // The three header counts are sent biased, so the encodable range starts at the
  // format's minimum rather than at zero.
  b.bits(hlit - 257, 5);
  b.bits(hdist - 1, 5);
  b.bits(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) b.bits(clLengths[CL_ORDER[i]] ?? 0, 3);

  const codes = canonical(clLengths);
  for (const op of ops) {
    const c = codes.get(op.sym);
    if (!c) throw new Error(`op uses symbol ${op.sym}, which has no code in clLengths`);
    b.code(c.code, c.len);
    const width = EXTRA_BITS[op.sym];
    if (width !== undefined) {
      if (op.extra === undefined) throw new Error(`symbol ${op.sym} is a run and needs an extra count`);
      b.bits(op.extra, width);
    } else if (op.extra !== undefined) {
      throw new Error(`symbol ${op.sym} is a literal length and takes no extra count`);
    }
  }
  return b;
}

/**
 * A code-length sequence that fills exactly `n` entries with zeros, using as few
 * operations as possible, then whatever `then` adds.
 *
 * Reaching the "run overflows the table" checks means arriving at the end of a 258-entry
 * table with a run still to go, and getting there one length at a time would need 258
 * operations. Symbol 18 covers 11..138 zeros at a time.
 */
export function fillZeros(n: number): ClOp[] {
  const ops: ClOp[] = [];
  let left = n;
  while (left >= 11) {
    const run = Math.min(138, left);
    ops.push({ sym: 18, extra: run - 11 });
    left -= run;
  }
  while (left > 0) {
    ops.push({ sym: 0 });
    left--;
  }
  return ops;
}

/** Assert `stream` is rejected. A decoder that accepts malformed input is the bug. */
export function mustTrap(inflate: (d: Uint8Array) => Uint8Array, name: string, stream: Uint8Array): void {
  let got: Uint8Array | undefined;
  try {
    got = inflate(stream);
  } catch {
    return;
  }
  const shown = got ? Array.from(got.slice(0, 16)).join(",") : "?";
  throw new Error(`${name}: expected a trap, got ${got?.length} bytes [${shown}]`);
}
