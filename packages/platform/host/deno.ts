// Deno's implementation of the world, on the main thread.
//
// Note how much of this is `await`. That is the reason the bridge exists: none of these
// are things wac could have called directly, and with the bridge the wac side does not
// know the difference.

import { type Handlers, serveHostCalls } from "./respond.ts";
import {
  blobWorker,
  type Child,
  failedChild,
  noSpawnHere,
  spawnChild,
  twoHandles,
  unpackSpawn,
  unpackSpawnSelf,
  want,
} from "./children.ts";
import { bridgeOf, CHUNK, newBridge } from "./layout.ts";
import { EMPTY_ARG, argBytes, i32le, i64le, readI32le, str, unstr } from "./call.ts";
import { GRANT_ENV, GRANT_NET, GRANT_READ, GRANT_WRITE, OP } from "./ops.ts";
import { ChildStack, joinPath, packCaptured, unpackPush } from "./child.ts";
import { ByteQueue } from "./queue.ts";
import {
  CHANGED_OK,
  FAULT_NOT_GRANTED,
  Faulted,
  STAT_BYTES,
  STAT_FAULT,
  changeBytes,
  changed,
  pathFailure,
  statFault,
} from "./faults.ts";

export type DenoWorldOptions = {
  /** Arguments the application sees. Defaults to none, not to the launcher's own. */
  /**
   * The program's arguments.
   *
   * Strings are accepted because that is what a launcher has — `Deno.args` is already text, and an
   * operating system that handed us bytes gave them to the runtime first. Bytes are accepted because a
   * *parent* has them exactly, and a spawned child must receive what its parent sent rather than a
   * UTF-8 round trip of it. wac-mono 0065.
   */
  args?: (string | Uint8Array)[];
  /** Where output goes. Defaults to the console. */
  log?(line: string): void;
  warn?(line: string): void;
  /** Restrict the filesystem, or leave it out for none at all. */
  fs?: { read?: boolean; write?: boolean };
  /** The network, or leave it out for none at all. */
  net?: boolean;
  /** Environment lookups, or leave it out to report every variable unset. */
  env?(name: string): string | undefined;
  /**
   * Where exact bytes go, and where standard input comes from.
   *
   * Absent means the real ones. A *spawned* world is given queues instead, which is how a
   * child's output reaches its parent through a handle rather than the terminal — the only
   * reason these exist.
   */
  write?(bytes: Uint8Array): void;
  /** Where exact bytes on the *error* stream go. A spawned world sends both to its parent. */
  writeErr?(bytes: Uint8Array): void;
  /**
   * Where this world's relative paths resolve from, and what `cwd` reports.
   *
   * A *spawned child* is the caller of this: a shell that has done `cd sub` starts its children
   * there, which is the difference between `cd sub; prog f` reading `sub/f` and reading `f`. Absent
   * means the process's own directory.
   */
  cwd?: string;
  /**
   * This program's own worker bundle, for `spawnSelf`.
   *
   * Passed by the launcher, which has it because it is what started the program. Absent means
   * `spawnSelf` answers "there is no spawn here" rather than failing — a world assembled by hand,
   * as the tests do, has no bundle to speak of.
   */
  selfSource?: string;
  readStdin?(): Promise<Uint8Array>;
  /**
   * One chunk of standard input, for `readChunk` and `recv(0)`.
   *
   * Separate from `readStdin` because they promise different things — everything, and something —
   * and for a spawned child the difference is the difference between sorting its input and sorting
   * the first line of it.
   */
  readStdinChunk?(): Promise<Uint8Array>;
};

const EMPTY = new Uint8Array(0);

/** A read answer, tagged: 0 data, 1 end, 2 failed. See `Read` in platform.wac. */
function data(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = 0;
  out.set(bytes, 1);
  return out;
}
const END = new Uint8Array([1]);
function failed(why: string): Uint8Array {
  const message = new TextEncoder().encode(why);
  const out = new Uint8Array(message.length + 1);
  out[0] = 2;
  out.set(message, 1);
  return out;
}

/** A `warn` payload as a line of a captured error stream: its bytes, then a newline. */
function lineOf(p: Uint8Array): Uint8Array {
  const out = new Uint8Array(p.length + 1);
  out.set(p, 0);
  out[p.length] = 10;
  return out;
}

/**
 * `recv(0)` reads standard input.
 *
 * Socket handles count from 1, so zero is free and can never collide. It exists so
 * `waitAny` can watch standard input beside a socket: `readChunk` is deliberately blocking
 * and ticketless — the streaming transforms take it as a bare funcref — so without this a
 * relay could wait on one side or the other but not both.
 */
export const STDIN_HANDLE = 0;

/** All of standard input. Deno needs no permission for this, and neither does the world. */
async function readAllStdin(): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const buf = new Uint8Array(65536);
  for (;;) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    parts.push(buf.slice(0, n));
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function writeAllStdout(bytes: Uint8Array): Promise<void> {
  let at = 0;
  while (at < bytes.length) at += await Deno.stdout.write(bytes.subarray(at));
}

/**
 * A handle, this socket's own port, and the peer's address — which is what `Socket` decodes.
 *
 * Three fields because a handle alone made `listen(…, 0)` useless: the kernel picks a free port and the
 * program could never learn which one, so every server had to guess a number and hope. Only `accept`
 * has a peer to name; the port is whatever the socket is bound to locally, and 0 where the runtime
 * does not say.
 */
function withPeer(handle: number, peer: string, port = 0): Uint8Array {
  const text = new TextEncoder().encode(peer);
  const out = new Uint8Array(8 + text.length);
  const view = new DataView(out.buffer);
  view.setInt32(0, handle, true);
  view.setInt32(4, port, true);
  out.set(text, 8);
  return out;
}

/** This end's port, or 0 for a transport that has none. */
function localPort(addr: Deno.Addr): number {
  return addr.transport === "tcp" || addr.transport === "udp" ? addr.port : 0;
}

/** The address at the other end, or empty where the runtime does not say. */
function peerOf(conn: Deno.Conn): string {
  const addr = conn.remoteAddr;
  return addr.transport === "tcp" || addr.transport === "udp" ? addr.hostname : "";
}

async function writeAllStderr(bytes: Uint8Array): Promise<void> {
  let at = 0;
  while (at < bytes.length) at += await Deno.stderr.write(bytes.subarray(at));
}

/**
 * The handler table for Deno.
 *
 * What is absent is as much the interface as what is present: with no `fs` option, a
 * `readFile` reports "filesystem not granted" rather than reading anything. The
 * application cannot tell the difference between a capability the host declined and one
 * that failed, which is the correct amount for it to know.
 */
async function denoDir(path: string): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(path)) names.push(e.name);
  return names.sort();
}

/**
 * `WAC_LOAD_GRACE_MS`, when it is set and readable.
 *
 * Only `spawn.test.ts` sets it, so that the one test which has to *wait out* the ready deadline waits a
 * second rather than the thirty a loaded machine may need. Read directly rather than through this
 * world's `env` option, because the deadline is the host's own affair and a program with no `env` grant
 * still has one; wrapped because a process without `--allow-env` throws on the attempt.
 */
function graceEnv(): number | undefined {
  try {
    const raw = Deno.env.get("WAC_LOAD_GRACE_MS");
    return raw === undefined ? undefined : Number(raw);
  } catch {
    return undefined;
  }
}

/**
 * Run a filesystem operation and, if it fails, say whether the *name* was the problem.
 *
 * A `NotFound` for a path containing U+FFFD is a name this runtime cannot express rather than a file that
 * is absent — see `pathFailure`. Wrapping every path-taking handler in this is what turns "no such file or
 * directory" for a file the user can see in `ls` into a sentence that is true. wac-mono 0065.
 */
async function onPath<T>(path: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    throw pathFailure(e, path);
  }
}

export function denoWorld(opts: DenoWorldOptions = {}): Handlers {
  const args = opts.args ?? [];
  const log = opts.log ?? ((l: string) => console.log(l));
  const warn = opts.warn ?? ((l: string) => console.error(l));
  // `Faulted`, so a withheld capability arrives as its own category rather than as an `EACCES` lookalike:
  // `FAULT_DENIED` is the file saying no, and this is the program never having been given the file.
  const deny = (what: string) => {
    throw new Faulted(FAULT_NOT_GRANTED, `${what} not granted to this application`);
  };
  const writeOut = opts.write;
  const writeErrOut = opts.writeErr;
  const selfSource = opts.selfSource;
  const readIn = opts.readStdin;
  const readChunkIn = opts.readStdinChunk ?? opts.readStdin;

  /**
   * Start a child on `source`, with `want` narrowed to this world's own authority.
   *
   * Shared by `spawn` and `spawnSelf`, which differ only in where the source comes from. The
   * intersection is a presence test against `opts`, which *is* the whole of this world's authority —
   * so there is no second list to keep in step. Asking for more than the parent has is not an error:
   * the child finds the capability denied, exactly as it would if the parent had asked for nothing.
   */
  const startChild = async (
    source: string,
    childArgs: Uint8Array[],
    wanted: number,
    childCwd: string,
    inheritIn: boolean,
  ): Promise<Uint8Array> => {
    const give = {
      read: (wanted & GRANT_READ) !== 0 && opts.fs?.read === true,
      write: (wanted & GRANT_WRITE) !== 0 && opts.fs?.write === true,
      net: (wanted & GRANT_NET) !== 0 && opts.net === true,
      env: (wanted & GRANT_ENV) !== 0 && opts.env !== undefined,
    };
    const h = nextHandle++;
    const child = spawnChild(source, childArgs, (sab, cargs, out, input, cerr) => {
      const enc = new TextEncoder();
      return serveHostCalls(bridgeOf(sab), denoWorld({
        args: cargs,
        // Absent rather than false where nothing is granted: the world reads a missing option as
        // "no such capability", and `fs: {}` is not the same as no `fs`.
        ...(give.read || give.write ? { fs: { read: give.read, write: give.write } } : {}),
        ...(give.net ? { net: true } : {}),
        ...(give.env ? { env: opts.env } : {}),
        // A line of output is bytes on the handle, with the newline `log` implies. The parent
        // cannot tell `log` from `write` — nor can a pipe, which is the point.
        log: async (l: string) => { await out.push(enc.encode(l + "\n")); },
        // ...and its error output goes to the *other* stream, which `recv(errHandle)` reads. A
        // program has two, and merging them made a shell count an error message in `cat x | wc -c`.
        warn: async (l: string) => { await cerr.push(enc.encode(l + "\n")); },
        // A full queue has to *fail* the write, or a program written to stop when the other end
        // goes away never learns: `box yes` is `while (cli.write(block)) {}`. Throwing is how the
        // host says false — the same shape `pushChild`'s cap uses.
        write: async (b: Uint8Array) => {
          // Awaited: a full queue *waits* for the parent to read, and only a queue that has ended
          // refuses. The two were one answer, and a producer told to stop when it should have waited
          // truncated a redirection silently — see `ByteQueue.push`.
          if (!await out.push(b)) throw new Error("the child's output is not being read");
        },
        writeErr: async (b: Uint8Array) => { await cerr.push(b); },
        // `readStdin` means *all* of it, which for a child means waiting for its input to end: the
        // bytes arrive over time. Serving it with one chunk made `seq 1 5 | sort -r` print `1`, since
        // `sort` reads to the end before sorting. `readChunk` and `recv` still take one chunk.
        // **An inheriting child reads what its parent's world reads** — the same stream, streaming
        // rather than buffered and *shared*, which is why `cat; cat` sees one line between them rather
        // than one each (issue 0042).
        //
        // It used to inherit by *omission*: leave the options out and the child falls through to
        // `Deno.stdin`. That is right for a program run from a terminal and wrong everywhere else. In a
        // test the parent's world has a queue — `harness/appRun.ts` gives the shell one and ends it — so
        // omitting handed the child the *test runner's* standard input instead, which never ends. The
        // child parked in `READ_CHUNK` for ever and its parent parked reading the child's output: a
        // cycle neither side can break. wac-mono 0082, found by running the corpus under a deterministic
        // scheduler, which reproduced it four times out of four where it had been one run in fifty.
        //
        // So an inheriting child takes the parent's source when the parent has one, and falls back to
        // the real thing only when the parent was reading the real thing too.
        ...(inheritIn
          ? {
            ...(opts.readStdin === undefined ? {} : { readStdin: opts.readStdin }),
            ...(opts.readStdinChunk === undefined ? {} : { readStdinChunk: opts.readStdinChunk }),
          }
          : {
            readStdin: () => input.rest(),
            readStdinChunk: () => input.next(),
          }),
        // So that a child can run itself as well: the bundle is the same one.
        selfSource: opts.selfSource,
        // Where its relative paths resolve from, and what its own `cwd()` reports. Empty means the
        // host's own directory, which is what a caller with no opinion passes.
        cwd: childCwd === "" ? opts.cwd : childCwd,
      }));
    }, newBridge, blobWorker, graceEnv());

    const why = await child.loaded;
    if (why !== "") {
      // Never registered, so there is no handle to close and nothing for the parent to clean up.
      child.kill();
      return failedChild(why);
    }
    // Two handles for one child: its output and its error stream. Numbered from the same counter, so
    // `waitAny` can watch both beside a socket without knowing which is which.
    const eh = nextHandle++;
    children.set(h, child);
    errStreams.set(eh, child.err);
    return twoHandles(h, eh, "");
  };

  // The current streaming input. One at a time rather than a handle per file, because the
  // wac side has no closures to carry a handle in — see the note in platform.wac.
  let source: Deno.FsFile | null = null;   // null means standard input
  let sink: Deno.FsFile | null = null;     // null means standard output
  /**
   * A destination for one read. **Never shared between reads.**
   *
   * A single buffer was safe while exactly one call could be outstanding, and is not now
   * that the bridge has a ring: two reads in flight both hand the kernel the same memory,
   * so the second write lands on top of the first and whichever resolves later returns a
   * length spanning both. Slicing after the read does not help — the corruption happens
   * during it.
   *
   * That failure looked like this, in `nc`: the peer received `"peer speaks first\nnd"`,
   * its own greeting with the tail of the client's message behind it. Eighteen bytes from
   * the socket read overlaid twenty-one from the standard-input read, in one buffer.
   *
   * One allocation per chunk, against a copy of the same size that was already happening.
   */
  const fresh = () => new Uint8Array(CHUNK);

  // Sockets by handle. A plain counter rather than reusing slots: a handle that has been
  // closed must never come back as a different connection, which is the kind of bug that
  // shows up as one request's answer arriving on another's socket.
  const sockets = new Map<number, Deno.Conn>();
  const listeners = new Map<number, Deno.Listener>();
  // Children share the handle space with sockets, so `recv`, `send` and `waitAny` need no
  // idea which they are holding — which is the whole reason a child is a handle.
  const children = new Map<number, Child>();
  /**
   * A child's error stream, by its own handle.
   *
   * Separate from `children` because it is a separate stream, and reading it is `recv` like anything
   * else — a handle is a handle, which is what lets `waitAny` watch a child's two streams and a
   * socket in one call.
   */
  const errStreams = new Map<number, ByteQueue>();
  let nextHandle = 1;

  // A program running inside this one: what it reads, what it writes, and where it stands.
  // `P` is applied to every path below and is the identity when nothing is pushed.
  const kids = new ChildStack();
  // `write` answers a bool and cannot carry a reason, so this is recorded for `outputError`. The
  // reads no longer need an equivalent: `Read` carries theirs.
  let outputFailure = "";
  // A path as this world means it: a pushed child's directory first, then this world's own. Both are
  // the same join — `joinPath` leaves an absolute path alone and ignores an empty base.
  const P = (path: string) => joinPath(opts.cwd ?? "", kids.path(path));

  return {
    [OP.NOW_MILLIS]: () => i64le(BigInt(Date.now())),
    [OP.MONOTONIC_NANOS]: () => i64le(BigInt(Math.round(performance.now() * 1e6))),
    // A timer, which is what makes a timeout expressible: waited on beside another ticket,
    // whichever lands first decides. Resolves to the monotonic nanoseconds at which it fired
    // rather than to nothing, so a caller can see the overshoot.
    //
    // `unrefTimer` is deliberately absent: an outstanding timer holding the event loop open
    // is what keeps a worker parked on it from waiting forever.
    // A read of where the host resolves relative paths. Not granted: it names a directory
    // rather than opening one, and a program that cannot read a file there learns nothing
    // useful from its name.
    [OP.CWD]: () => str(opts.cwd !== undefined && opts.cwd !== "" ? opts.cwd : Deno.cwd()),
    [OP.SLEEP_MILLIS]: (p) =>
      new Promise<Uint8Array>((ok) =>
        setTimeout(() => ok(i64le(BigInt(Math.round(performance.now() * 1e6)))), readI32le(p))
      ),
    [OP.RANDOM_BYTES]: (p) => {
      const n = readI32le(p);
      if (n < 0 || n > 1 << 20) throw new Error(`randomBytes(${n}) out of range`);
      return crypto.getRandomValues(new Uint8Array(n));
    },
    // `log` is standard output, so a child's lines are kept with the rest of its output rather
    // than appearing on the parent's terminal. Thirty of `box`'s applets write this way.
    [OP.LOG]: (p) => {
      if (kids.active) { kids.write(lineOf(p)); return EMPTY; }
      log(unstr(p));
      return EMPTY;
    },
    // `warn` is standard error, so a child's diagnostics are kept with its output rather than
    // landing on the parent's terminal in the middle of a pipeline. A newline is added because
    // `warn` is a line-at-a-time capability and a captured stream is bytes.
    [OP.WARN]: (p) => {
      if (kids.warn(lineOf(p))) return EMPTY;
      warn(unstr(p));
      return EMPTY;
    },

    [OP.PUSH_CHILD]: (p) => {
      const { argv, stdin, cwd } = unpackPush(p);
      kids.push(argv, stdin, cwd);
      return EMPTY;
    },
    [OP.POP_CHILD]: () => {
      const { out, err } = kids.pop();
      return packCaptured(out, err);
    },

    // A child has its own command line: an applet reading `cli.arg(1)` must see what the shell
    // typed, not what the shell itself was started with.
    [OP.ARG_COUNT]: () => i32le((kids.args() ?? args).length),
    [OP.ARG]: (p) => {
      const own = kids.args() ?? args;
      const i = readI32le(p);
      // The bytes, unchanged. A program that wants text says `string.fromBytes` on its own side.
      return i >= 0 && i < own.length ? argBytes(own[i]) : EMPTY_ARG;
    },
    [OP.ENV]: (p) => {
      const v = opts.env?.(unstr(p));
      if (v === undefined) return new Uint8Array([0]);
      const b = str(v);
      const out = new Uint8Array(1 + b.length);
      out[0] = 1;
      out.set(b, 1);
      return out;
    },

    // Genuinely asynchronous, and the wac side calls it like a function.
    [OP.READ_FILE]: async (p) => {
      if (!opts.fs?.read) deny("filesystem read");
      const path = P(unstr(p));
      return await onPath(path, () => Deno.readFile(path));
    },

    // stdin and stdout need no grant: what the user pipes in and what the program prints
    // are the user's own doing, not a reach into something they did not offer.
    [OP.READ_STDIN]: async () =>
      kids.readAll() ?? (readIn === undefined ? await readAllStdin() : await readIn()),
    [OP.WRITE_STDOUT]: async (p) => {
      if (kids.active) {
        if (!kids.write(p)) throw new Error("the child's output buffer is full");
        return EMPTY;
      }
      // **`openOutput`'s file first, and the caller's `write` second.** These were the other way round,
      // so a caller that supplies `write` — every spawned child, and `harness/appRun.ts` — silently lost
      // the redirection: `openOutput` truncated the file and every byte still went to the caller's sink.
      // Nothing noticed because nothing had asked a *child* to redirect its own output until `sh` began
      // streaming into `> file` (wac-mono 0070); `box wget url out` run as a child wrote an empty file.
      //
      // The order is not arbitrary. `write` in the options says where *standard output* goes;
      // `openOutput` is the program saying its output is a file now, which is not standard output.
      try {
        if (sink !== null) {
          let at = 0;
          while (at < p.length) at += await sink.write(p.subarray(at));
          return EMPTY;
        }
        if (writeOut !== undefined) { writeOut(p.slice()); return EMPTY; }
        await writeAllStdout(p);
        return EMPTY;
      } catch (e) {
        // Recorded and then rethrown: the throw is what makes `write` answer false, and the record
        // is what lets a caller tell a full disk from a reader that went away.
        const message = e instanceof Error ? e.message : String(e);
        outputFailure = /broken pipe|os error 32/i.test(message) ? "" : message;
        throw e;
      }
    },

    /**
     * Standard error as bytes, beside `warn`'s line.
     *
     * Deliberately *not* through `sink`: `openOutput` redirects standard output, and a redirection
     * that took the error stream with it would make the two impossible to separate — which is the
     * whole reason a program has two of them.
     */
    [OP.WRITE_STDERR]: async (p) => {
      if (kids.active) { kids.warn(p); return EMPTY; }
      if (writeErrOut !== undefined) { writeErrOut(p.slice()); return EMPTY; }
      try {
        await writeAllStderr(p);
        return EMPTY;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        outputFailure = /broken pipe|os error 32/i.test(message) ? "" : message;
        throw e;
      }
    },

    [OP.STAT]: async (p) => {
      const out = new Uint8Array(STAT_BYTES);
      const dv = new DataView(out.buffer);
      // Not granted is not absence, and it is not denial either. A program with no read capability was
      // told "does not exist", then "permission denied" — the first blames the path and the second blames
      // the file's mode, and both send a reader looking at a filesystem that was never handed over.
      if (!opts.fs?.read) {
        out[STAT_FAULT] = FAULT_NOT_GRANTED;
        return out;
      }
      const path = P(unstr(p));
      try {
        const st = await Deno.stat(path);
        out[0] = 1;
        out[1] = st.isFile ? 1 : 0;
        out[2] = st.isDirectory ? 1 : 0;
        dv.setBigInt64(3, BigInt(st.size), true);
        dv.setBigInt64(11, BigInt(st.mtime?.getTime() ?? 0), true);
        // `stat` follows, so what it describes is never itself a link. `linkStat` is the one that
        // answers that, and it is the only difference between these two handlers.
      } catch (e) {
        // Absence stays absence — zeroes and `FAULT_NONE`. Anything else says which way it failed, so a
        // name this runtime cannot express is not reported as a file that is not there.
        out[STAT_FAULT] = statFault(e, path);
      }
      return out;
    },
    [OP.LINK_STAT]: async (p) => {
      const out = new Uint8Array(STAT_BYTES);
      const dv = new DataView(out.buffer);
      if (!opts.fs?.read) {
        out[STAT_FAULT] = FAULT_NOT_GRANTED;
        return out;
      }
      const path = P(unstr(p));
      try {
        const st = await Deno.lstat(path);
        out[0] = 1;
        out[1] = st.isFile ? 1 : 0;
        out[2] = st.isDirectory ? 1 : 0;
        dv.setBigInt64(3, BigInt(st.size), true);
        dv.setBigInt64(11, BigInt(st.mtime?.getTime() ?? 0), true);
        out[19] = st.isSymlink ? 1 : 0;
      } catch (e) {
        out[STAT_FAULT] = statFault(e, path);
      }
      return out;
    },

    [OP.READ_DIR]: async (p) => {
      if (!opts.fs?.read) deny("filesystem read");
      const path = P(unstr(p));
      const names = await onPath(path, () => denoDir(path));
      return str(names.join("\u0000"));
    },
    // The four changes answer a `Change` rather than throwing: a fault category and the host's own
    // words. A refusal for want of a grant is a `Denied` like any other, said in the same shape.
    [OP.WRITE_FILE]: (p) => {
      if (!opts.fs?.write) return changeBytes(FAULT_NOT_GRANTED, "filesystem write not granted to this application");
      const n = readI32le(p);
      const path = P(unstr(p.subarray(4, 4 + n)));
      return changed(() => onPath(path, () => Deno.writeFile(path, p.subarray(4 + n))));
    },

    // The mutation tier. Each throws on failure and the wac side reads that as `false`,
    // so an application never has to tell "not permitted" from "did not exist" — which
    // is again the correct amount for it to know.
    [OP.OPEN_INPUT]: async (p) => {
      const path = unstr(p);
      source?.close();
      source = null;
      if (path === "") return CHANGED_OK;      // standard input, and the default
      // `changed`, so "not there" is `FAULT_NOT_FOUND` and the caller can say what `cat` says —
      // the streaming half used to answer with the host's sentence while `readFile` answered a
      // category, which is one program wording one failure two ways.
      if (!opts.fs?.read) return changeBytes(FAULT_NOT_GRANTED, "filesystem read not granted to this application");
      const full = P(path);
      return await changed(async () => {
        source = await onPath(full, () => Deno.open(full, { read: true }));
      });
    },
    [OP.READ_CHUNK]: async () => {
      // A pushed child reads what it was fed and then end of input — never the parent's own
      // standard input, which would let a filter inside a shell swallow the terminal.
      const fed = source === null ? kids.readChunk() : null;
      if (fed !== null) return fed.length === 0 ? END : data(fed);
      if (source === null && readChunkIn !== undefined) {
        const piped = await readChunkIn();
        return piped.length === 0 ? END : data(piped);
      }
      try {
        const into = fresh();
        const n = source === null ? await Deno.stdin.read(into) : await source.read(into);
        // A short read is not the end; only null is.
        return n === null ? END : data(into.subarray(0, n));
      } catch (e) {
        // The third state, said out loud. This used to answer with nothing, which the caller could
        // only read as "finished".
        return failed(e instanceof Error ? e.message : String(e));
      }
    },
    [OP.OUTPUT_ERROR]: () => str(outputFailure),

    [OP.OPEN_OUTPUT]: async (p) => {
      const path = unstr(p);
      // Closed before the next one opens, so a program that has finished writing a file
      // can rename over it — see the note in platform.wac.
      sink?.close();
      sink = null;
      if (path === "") return CHANGED_OK;
      if (!opts.fs?.write) return changeBytes(FAULT_NOT_GRANTED, "filesystem write not granted to this application");
      // `changed`, so a directory that does not exist is `FAULT_NOT_FOUND` rather than an errno and an
      // absolute path in somebody's shell diagnostic.
      const full = P(path);
      return await changed(() =>
        onPath(full, async () => {
          sink = await Deno.open(full, { write: true, create: true, truncate: true });
        })
      );
    },

    [OP.CONNECT]: async (p) => {
      if (!opts.net) deny("network access");
      const port = readI32le(p);
      const conn = await Deno.connect({ hostname: unstr(p.subarray(4)), port });
      const h = nextHandle++;
      sockets.set(h, conn);
      return withPeer(h, "", localPort(conn.localAddr));
    },
    /**
     * Bind an address and a port. See `listen` in platform.wac for why the address is a parameter.
     *
     * An empty address means every interface, which is what `Deno.listen` does with no hostname and
     * what this did unconditionally before. `"127.0.0.1"` is the one a program can now ask for.
     */
    [OP.LISTEN]: (p) => {
      if (!opts.net) deny("network access");
      const address = unstr(p.subarray(4));
      const l = Deno.listen(
        address === "" ? { port: readI32le(p) } : { hostname: address, port: readI32le(p) },
      );
      const h = nextHandle++;
      listeners.set(h, l);
      // The port it *got*, which is the whole point of being allowed to ask for 0.
      return withPeer(h, "", localPort(l.addr));
    },
    [OP.ACCEPT]: async (p) => {
      const l = listeners.get(readI32le(p));
      if (l === undefined) throw new Error("not a listening socket");
      const conn = await l.accept();
      const h = nextHandle++;
      sockets.set(h, conn);
      // The peer's address travels with the handle, so a server can log it, rate-limit by it, or
      // refuse a connection that did not come from this machine. It was dropped here before.
      return withPeer(h, peerOf(conn), localPort(conn.localAddr));
    },
    [OP.RECV]: async (p) => {
      const h = readI32le(p);
      // Handle 0 is standard input. Handles count from 1, so it can never be a socket, and
      // giving stdin one means `waitAny` can watch it beside a socket — which is what a
      // relay like `nc` needs and could not express while stdin was only `readChunk`.
      if (h === STDIN_HANDLE && readChunkIn !== undefined) {
        const piped = await readChunkIn();
        return piped.length === 0 ? END : data(piped);
      }
      const into = fresh();
      if (h === STDIN_HANDLE) {
        const n = await Deno.stdin.read(into);
        return n === null ? END : data(into.subarray(0, n));
      }
      const kid = children.get(h);
      if (kid !== undefined) {
        const fromChild = await kid.out.next();
        return fromChild.length === 0 ? END : data(fromChild);
      }
      const complaint = errStreams.get(h);
      if (complaint !== undefined) {
        const said = await complaint.next();
        return said.length === 0 ? END : data(said);
      }
      const c = sockets.get(h);
      if (c === undefined) return failed("not an open socket");
      try {
        const n = await c.read(into);
        // null is the peer closing: an answer, not a failure.
        return n === null ? END : data(into.subarray(0, n));
      } catch (e) {
        // A reset or a timeout. `recv` used to report this as "nothing", so a truncated stream and a
        // complete one were the same answer.
        return failed(e instanceof Error ? e.message : String(e));
      }
    },
    [OP.SEND]: async (p) => {
      const h = readI32le(p);
      const kid = children.get(h);
      if (kid !== undefined) { kid.in.push(p.slice(4)); return EMPTY; }
      const c = sockets.get(h);
      if (c === undefined) throw new Error("not an open socket");
      const body = p.subarray(4);
      let at = 0;
      while (at < body.length) at += await c.write(body.subarray(at));
      return EMPTY;
    },
    [OP.CLOSE_SOCKET]: (p) => {
      const h = readI32le(p);
      // Closing an already-closed socket is not an error; a program that tidies up on
      // every path would otherwise have to track which paths had already done it.
      try { sockets.get(h)?.close(); } catch { /* already closed */ }
      try { listeners.get(h)?.close(); } catch { /* already closed */ }
      // Closing a child's handle ends its standard input *and* stops it. A program that
      // wants only the first should stop sending and wait for its output to end.
      try { children.get(h)?.in.end(); children.get(h)?.kill(); } catch { /* gone */ }
      sockets.delete(h);
      listeners.delete(h);
      children.delete(h);
      errStreams.delete(h);
      return EMPTY;
    },

    /**
     * A worker on the source it is handed, wired to queues.
     *
     * The child gets its own bridge and its own world — nothing is shared, and each needs
     * its own world *instance* because these handlers close over the current input, the
     * current output and the socket map. One table between two children would hand one of
     * them the other's socket.
     *
     * Its world is granted nothing: no filesystem, no network. `log`, `warn` and `write` all
     * arrive at the parent through the handle, and its reads come from what the parent
     * sends. See the notes in `children.ts` and `platform.wac`.
     *
     * **Answers only once the source has loaded**, which is what makes a file that is not a worker
     * bundle a failed child rather than a dead parent: the load error used to escape into this
     * process. A handle and no message means it is running; -1 and a message means it never
     * started, which is what `Child.error` is for. wac-mono issue 0021.
     */
    [OP.SPAWN]: (p) => {
      const { source, args, cwd, inheritIn } = unpackSpawn(p);
      return startChild(source, args, want(p), cwd, inheritIn);
    },

    /**
     * This same program again, with different arguments. See `spawnSelf` in platform.wac.
     *
     * The source is the one the launcher started this program with — no file, no path, no grant. A
     * child spawned this way is handed it too, so a program that runs itself can go on doing so.
     */
    [OP.SPAWN_SELF]: (p) => {
      if (selfSource === undefined) {
        return noSpawnHere("this launcher did not pass the program its own source");
      }
      const { args, cwd, inheritIn } = unpackSpawnSelf(p);
      return startChild(selfSource, args, want(p), cwd, inheritIn);
    },

    [OP.CLOSE_FEED]: (p) => {
      // Input only. `closeSocket` is what stops a child; a program that reads to the end
      // before answering needs that end while it is still alive.
      children.get(readI32le(p))?.in.end();
      return EMPTY;
    },

    [OP.EXIT_CODE]: async (p) => {
      const c = children.get(readI32le(p));
      if (c === undefined) throw new Error("not a spawned worker");
      return i32le(await c.exit);
    },

    [OP.MKDIR]: (p) => {
      if (!opts.fs?.write) return changeBytes(FAULT_NOT_GRANTED, "filesystem write not granted to this application");
      const dir = P(unstr(p.subarray(1)));
      return changed(() => onPath(dir, () => Deno.mkdir(dir, { recursive: p[0] === 1 })));
    },
    [OP.REMOVE]: (p) => {
      if (!opts.fs?.write) return changeBytes(FAULT_NOT_GRANTED, "filesystem write not granted to this application");
      const victim = P(unstr(p.subarray(1)));
      return changed(() => onPath(victim, () => Deno.remove(victim, { recursive: p[0] === 1 })));
    },
    [OP.RENAME]: (p) => {
      if (!opts.fs?.write) return changeBytes(FAULT_NOT_GRANTED, "filesystem write not granted to this application");
      const n = readI32le(p);
      const from = P(unstr(p.subarray(4, 4 + n)));
      const to = P(unstr(p.subarray(4 + n)));
      // The source first: a rename fails on whichever name the host cannot express, and reporting the
      // destination for a source it could not read would send the reader to the wrong half.
      return changed(() => onPath(from, () => onPath(to, () => Deno.rename(from, to))));
    },
  };
}
