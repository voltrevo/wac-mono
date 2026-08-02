// An FSE table-description *writer*, for tests.
//
// The decoder's inverse, written from the same section of RFC 8878 and deliberately not from
// the decoder. Round-tripping through it checks the reader against something that had to make
// the same decisions in reverse — where a count stops fitting in `nbBits - 1`, when the field
// narrows, how a run of unused symbols is spelled. A shared misreading would still agree, so
// this is not an oracle; it is a much better fuzzer than random bytes, which never once
// produce a valid description.
//
// It also reaches shapes real zstd output does not: long runs of unused symbols, and
// distributions that lean entirely on the "less than one" count.

/** Bits, least significant first within a byte, which is how a description is written. */
class BitOut {
  private bytes: number[] = [];
  private cur = 0;
  private used = 0;

  push(value: number, bits: number): void {
    for (let i = 0; i < bits; i++) {
      this.cur |= ((value >>> i) & 1) << this.used;
      this.used++;
      if (this.used === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.used = 0;
      }
    }
  }

  finish(): Uint8Array {
    if (this.used > 0) this.bytes.push(this.cur);
    return new Uint8Array(this.bytes);
  }
}

/**
 * Write the description for `counts` at accuracy `log`.
 *
 * `counts` uses -1 for a symbol that is possible but rarer than one slot, exactly as the
 * decoder reports it. The counts must account for the whole table: the sum of `|count|` has to
 * be `1 << log`.
 */
export function writeDescription(counts: number[], log: number): Uint8Array {
  // The accuracy log is written as `log - 5` in four bits, so five is the smallest table the
  // format can describe at all — there is no way to spell a 16-state table.
  if (log < 5 || log > 20) throw new Error(`accuracy log ${log} is outside 5..20`);
  const size = 1 << log;
  const sum = counts.reduce((n, c) => n + Math.abs(c), 0);
  if (sum !== size) throw new Error(`counts sum to ${sum}, need ${size} for log ${log}`);

  const out = new BitOut();
  out.push(log - 5, 4);

  let remaining = size + 1;
  let threshold = size;
  let nbBits = log + 1;
  let i = 0;

  while (i < counts.length && remaining > 1) {
    const count = counts[i];
    const stored = count + 1;                    // the wire form is offset by one
    const max = (2 * threshold - 1) - remaining;

    // Small values take one bit fewer. The reader distinguishes them by comparing against the
    // same `max`, so the choice here is forced, not free.
    if (stored < max) {
      out.push(stored, nbBits - 1);
    } else {
      let v = stored;
      if (v >= threshold) v += max;              // the reader subtracts this back off
      out.push(v, nbBits);
    }

    remaining -= Math.abs(count);
    while (remaining < threshold) {
      nbBits--;
      threshold >>>= 1;
    }
    i++;

    // A zero count opens a run: the next field is a repeat length in units of three, and it is
    // written even when the run is empty.
    if (count === 0) {
      let zeros = 0;
      while (i + zeros < counts.length && counts[i + zeros] === 0) zeros++;
      let left = zeros;
      while (left >= 3) {
        out.push(3, 2);
        left -= 3;
      }
      out.push(left, 2);
      i += zeros;
    }
  }
  return out.finish();
}

/** A description followed by a bitstream, which is what `decompress` takes. */
export function withStream(desc: Uint8Array, stream: Uint8Array): Uint8Array {
  const out = new Uint8Array(desc.length + stream.length);
  out.set(desc, 0);
  out.set(stream, desc.length);
  return out;
}
