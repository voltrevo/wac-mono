// The world a child program sees, while it is running inside its parent.
//
// `pushChild` and `popChild` in `platform.wac` are two capabilities and this is all of their
// state. It lives in one file rather than in each host because the three hosts would otherwise
// grow three copies of the same stack, and the interesting parts — that a short read is not the
// end, that a path is only joined when there is something to join it to — are exactly the parts
// that would drift.
//
// Nothing here does I/O. Each host asks it three questions while serving a call:
//
//   `stack.readChunk()`  — is the current input a fed buffer, and if so what comes next?
//   `stack.write(bytes)` — is output being kept rather than written?
//   `stack.path(p)`      — what does this relative path mean from where the child stands?
//
// If the answer is "no child", each returns something falsy and the host carries on exactly as
// it did before. That is deliberate: a program that never pushes must take the same path through
// the host as it did when this file did not exist.

/** Matching `CHUNK` in the bridge: what a single `readChunk` may answer with at most. */
const CHUNK = 1 << 16;

/**
 * How much a child may write before `write` starts answering false.
 *
 * A cap is needed because the output is held in memory rather than draining anywhere, and the
 * program deciding how much to produce is not the one holding it. `box yes` writes for ever by
 * design.
 *
 * False is the right answer rather than a thrown error or a silent drop: `write` already means
 * "a closed pipe is an answer, not a crash", and `yes` is written as `while (cli.write(block)) {}`
 * precisely so that it stops when the other end goes away. So a full buffer ends an infinite
 * producer the same way `head` exiting does, and a program that ignores the answer spins here
 * exactly as it would against a full disk.
 */
const CAP = 8 << 20;

type Frame = {
  /**
   * The child's own command line, in the layout `box` uses: the program's name, then its
   * arguments. An applet that reads `cli.arg(i)` rather than the parsed `Args` — `seq` does, and
   * has a good reason — sees this instead of the process's.
   */
  argv: string[];
  /** What the child reads, and how far it has read. */
  stdin: Uint8Array;
  at: number;
  /** Where its relative paths resolve from. Empty means "wherever the host already was". */
  cwd: string;
  out: Uint8Array[];
  err: Uint8Array[];
  /** How much `out` holds, so the cap costs no walk of the list. */
  written: number;
};

/**
 * Join a child's directory onto a path the child gave.
 *
 * Absolute paths are left alone, as they are in every shell: `cd sub; cat /etc/hosts` reads
 * `/etc/hosts`. So is the case where the child was pushed with no directory of its own, which is
 * what a program running in the host's own directory wants.
 *
 * `.` and `..` are *not* resolved here. The shell that pushes has already normalised its own
 * working directory, and a path the child constructed is the host's business to interpret —
 * every host below this understands `..`, and reimplementing it here would be a second opinion
 * about what a path means.
 */
export function joinPath(cwd: string, path: string): string {
  if (cwd === "" || path.startsWith("/")) return path;
  if (path === "") return cwd;
  return cwd.endsWith("/") ? cwd + path : cwd + "/" + path;
}

export class ChildStack {
  private frames: Frame[] = [];

  /** Whether a child is running, which is the only question most call sites have. */
  get active(): boolean {
    return this.frames.length > 0;
  }

  private get top(): Frame | undefined {
    return this.frames[this.frames.length - 1];
  }

  push(argv: string[], stdin: Uint8Array, cwd: string): void {
    this.frames.push({ argv, stdin, at: 0, cwd, out: [], err: [], written: 0 });
  }

  /** The child's arguments, or null when none is running. */
  args(): string[] | null {
    return this.top?.argv ?? null;
  }

  /**
   * End the innermost child and answer with what it wrote.
   *
   * A pop with nothing pushed gives two empty arrays rather than throwing. The caller has
   * nothing to undo, and a program that pops once too often has a bug that a thrown error here
   * would report as the host's.
   */
  pop(): { out: Uint8Array; err: Uint8Array } {
    const frame = this.frames.pop();
    if (frame === undefined) return { out: new Uint8Array(0), err: new Uint8Array(0) };
    return { out: concat(frame.out), err: concat(frame.err) };
  }

  /**
   * The next chunk of the child's input, or null if no child is running.
   *
   * An empty array means end of input and is *not* null: the child has been given everything
   * there was, which is a different answer from "ask the host instead".
   */
  readChunk(): Uint8Array | null {
    const frame = this.top;
    if (frame === undefined) return null;
    const end = Math.min(frame.at + CHUNK, frame.stdin.length);
    const slice = frame.stdin.subarray(frame.at, end);
    frame.at = end;
    return slice;
  }

  /** Everything the child has not read yet, for a `readStdin` that wants it in one piece. */
  readAll(): Uint8Array | null {
    const frame = this.top;
    if (frame === undefined) return null;
    const rest = frame.stdin.subarray(frame.at);
    frame.at = frame.stdin.length;
    return rest;
  }

  /**
   * Keep these bytes as the child's output. **Only call this when `active`** — the answer here is
   * whether the child may write *more*, not whether anyone kept these.
   *
   * False means the buffer is full, and the host's job is then to throw: `write` in `platform.wac`
   * reports a closed pipe by the host call failing, which is how `while (cli.write(block)) {}` in
   * `box yes` learns to stop. Returning false without throwing would have sent the overflow to the
   * real standard output instead, in the middle of a shell pipeline.
   *
   * Copied rather than kept, because the caller's array is a view into the ring buffer and the
   * next call overwrites it. Getting this wrong gives a child whose output is the *last* thing it
   * wrote, repeated — which looks like a bug in the program rather than in the host.
   */
  write(bytes: Uint8Array): boolean {
    const frame = this.top;
    if (frame === undefined) return false;
    if (frame.written + bytes.length > CAP) return false;
    frame.out.push(bytes.slice());
    frame.written += bytes.length;
    return true;
  }

  /**
   * The same for standard error, which is where `Core.warn` goes. Uncapped: diagnostics are
   * bounded by the program having something to complain about, and `warn` cannot report a
   * refusal — it hands back nothing at all.
   */
  warn(bytes: Uint8Array): boolean {
    const frame = this.top;
    if (frame === undefined) return false;
    frame.err.push(bytes.slice());
    return true;
  }

  /** A path as the child means it. Unchanged when no child is running. */
  path(p: string): string {
    const frame = this.top;
    return frame === undefined ? p : joinPath(frame.cwd, p);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The payload `popChild` answers with: standard output length-prefixed, then standard error. */
export function packCaptured(out: Uint8Array, err: Uint8Array): Uint8Array {
  const payload = new Uint8Array(4 + out.length + err.length);
  new DataView(payload.buffer).setInt32(0, out.length, true);
  payload.set(out, 4);
  payload.set(err, 4 + out.length);
  return payload;
}

/**
 * The payload `pushChild` sends: how many arguments, then the arguments NUL-separated and
 * length-prefixed, then the directory length-prefixed, then the input.
 *
 * The count travels separately from the joined string because splitting cannot tell no arguments
 * from one empty argument — `"".split("\0")` is `[""]` either way.
 */
export function unpackPush(p: Uint8Array): { argv: string[]; stdin: Uint8Array; cwd: string } {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const count = dv.getInt32(0, true);
  const argvLen = dv.getInt32(4, true);
  const dec = new TextDecoder();
  const argv = count === 0 ? [] : dec.decode(p.subarray(8, 8 + argvLen)).split("\u0000");
  const cwdAt = 8 + argvLen;
  const cwdLen = dv.getInt32(cwdAt, true);
  const cwd = dec.decode(p.subarray(cwdAt + 4, cwdAt + 4 + cwdLen));
  // Copied: `p` is a view into the ring and will be overwritten by the next call, but the child
  // reads its input over many calls.
  return { argv, stdin: p.slice(cwdAt + 4 + cwdLen), cwd };
}
