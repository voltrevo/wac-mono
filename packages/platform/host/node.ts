// Node's implementation of the world.
//
// The same `Handlers` table as `deno.ts`, over Node's APIs. That the two are
// interchangeable is the point of the bridge: the wac side, the capability structs and
// the opcodes are identical, and only these dozen closures differ.
//
// **Node has no permission system**, so `grants` here is the whole boundary rather than
// half of it. Under Deno a build that withholds the filesystem is enforced twice — by the
// capability world and by the process — and under Node only by the world. That is a real
// difference and the README says so; it is not a reason to skip the grant, because the
// world is what an application is written against either way.

import { type Handlers } from "./respond.ts";
import { i32le, i64le, readI32le, str, unstr } from "./call.ts";
import { OP } from "./ops.ts";
import { ChildStack, packCaptured, unpackPush } from "./child.ts";

/** Node's pieces, described rather than imported, so this file checks under Deno. */
export type NodeIo = {
  readStdin(): Promise<Uint8Array>;
  /** One chunk of standard input, or empty at its end. */
  readStdinChunk(): Promise<Uint8Array>;
  /** A file opened for sequential reading; `read` answers empty at the end. */
  openFile(path: string): Promise<{ read(): Promise<Uint8Array>; close(): Promise<void> }>;
  /** A file opened for writing, truncated. */
  createFile(path: string): Promise<{ write(b: Uint8Array): Promise<void>; close(): Promise<void> }>;
  /**
   * The network, in the same shape Deno's is.
   *
   * Node's `net` is event-based, so the wrapper that gives it this shape lives in
   * `entryNode.ts` where the module is actually available. What crosses here is already
   * promise-shaped, which is all the bridge needs.
   */
  connect(host: string, port: number): Promise<NodeSock>;
  listen(port: number): Promise<NodeListener>;
  writeStdout(bytes: Uint8Array): Promise<void>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtimeMillis: number }>;
  /**
   * `stat` without following the last component. Optional: a host that cannot tell answers as `stat`
   * does, which is honest for a filesystem with no links and wrong for nothing.
   */
  linkStat?(
    path: string,
  ): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtimeMillis: number; isSymlink: boolean }>;
  readDir(path: string): Promise<string[]>;
};

/** One connection, however the platform underneath spells it. */
export type NodeSock = {
  recv(): Promise<Uint8Array>;   // empty when the peer has closed
  send(b: Uint8Array): Promise<void>;
  close(): void;
};

export type NodeListener = {
  accept(): Promise<NodeSock>;
  close(): void;
};

export type NodeWorldOptions = {
  args?: string[];
  log?(line: string): void;
  warn?(line: string): void;
  fs?: { read?: boolean; write?: boolean };
  net?: boolean;
  env?(name: string): string | undefined;
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

/** Node's globals, described rather than imported, so this file type-checks under Deno. */
type NodeProcess = { argv: string[]; env: Record<string, string | undefined> };
type NodeFs = {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string, opts: { recursive: boolean }): Promise<unknown>;
  rm(path: string, opts: { recursive: boolean; force: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
};

export function nodeWorld(
  fs: NodeFs,
  proc: NodeProcess,
  io: NodeIo,
  opts: NodeWorldOptions = {},
): Handlers {
  const args = opts.args ?? proc.argv.slice(2);
  const log = opts.log ?? ((l: string) => console.log(l));
  const warn = opts.warn ?? ((l: string) => console.error(l));

  // The current streaming input; null means standard input. See the note in platform.wac.
  let source: { read(): Promise<Uint8Array>; close(): Promise<void> } | null = null;
  let sink: { write(b: Uint8Array): Promise<void>; close(): Promise<void> } | null = null;

  const sockets = new Map<number, NodeSock>();
  const listeners = new Map<number, NodeListener>();
  let nextHandle = 1;
  const deny = (what: string) => { throw new Error(`${what} not granted to this application`); };

  // A program running inside this one. `P` is the identity when nothing is pushed.
  const kids = new ChildStack();
  // `write` answers a bool and cannot carry a reason, so this is recorded for `outputError`. The
  // reads no longer need an equivalent: `Read` carries theirs.
  let outputFailure = "";
  const P = (path: string) => kids.path(path);

  return {
    [OP.NOW_MILLIS]: () => i64le(BigInt(Date.now())),
    [OP.MONOTONIC_NANOS]: () => i64le(BigInt(Math.round(performance.now() * 1e6))),
    // A timer, which is what makes a timeout expressible: waited on beside another ticket,
    // whichever lands first decides. Resolves to the monotonic nanoseconds at which it fired
    // rather than to nothing, so a caller can see the overshoot.
    //
    // `unref()` is deliberately absent: an outstanding timer holding the event loop open
    // is what keeps a worker parked on it from waiting forever.
    [OP.CWD]: () => str(process.cwd()),
    [OP.SLEEP_MILLIS]: (p) =>
      new Promise<Uint8Array>((ok) =>
        setTimeout(() => ok(i64le(BigInt(Math.round(performance.now() * 1e6)))), readI32le(p))
      ),
    [OP.RANDOM_BYTES]: (p) => {
      const n = readI32le(p);
      if (n < 0 || n > 1 << 20) throw new Error(`randomBytes(${n}) out of range`);
      // getRandomValues caps at 64KiB per call on every engine that has it.
      const out = new Uint8Array(n);
      for (let at = 0; at < n; at += 65536) {
        crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, n)));
      }
      return out;
    },
    // `log` is standard output, so a child's lines are kept with the rest of its output rather
    // than appearing on the parent's terminal. Thirty of `box`'s applets write this way.
    [OP.LOG]: (p) => {
      if (kids.active) { kids.write(lineOf(p)); return EMPTY; }
      log(unstr(p));
      return EMPTY;
    },
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
      return str(i >= 0 && i < own.length ? own[i] : "");
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

    [OP.READ_FILE]: async (p) => {
      if (!opts.fs?.read) deny("filesystem read");
      // Node hands back a Buffer, which is a Uint8Array — but a *view* into a pooled
      // allocation, so it is copied rather than parked in the bridge as it came.
      return new Uint8Array(await fs.readFile(P(unstr(p))));
    },

    // stdin and stdout need no grant: what the user pipes in and what the program prints
    // are the user's own doing, not a reach into something they did not offer.
    [OP.READ_STDIN]: async () => kids.readAll() ?? await io.readStdin(),
    [OP.WRITE_STDOUT]: async (p) => {
      if (kids.active) {
        if (!kids.write(p)) throw new Error("the child's output buffer is full");
        return EMPTY;
      }
      try {
        if (sink === null) { await io.writeStdout(p); return EMPTY; }
        await sink.write(p);
        return EMPTY;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        outputFailure = /EPIPE|broken pipe/i.test(message) ? "" : message;
        throw e;
      }
    },

    [OP.STAT]: async (p) => {
      const out = new Uint8Array(20);
      const dv = new DataView(out.buffer);
      if (!opts.fs?.read) return out; // not granted reads as "does not exist"
      try {
        const st = await io.stat(P(unstr(p)));
        out[0] = 1;
        out[1] = st.isFile ? 1 : 0;
        out[2] = st.isDirectory ? 1 : 0;
        dv.setBigInt64(3, BigInt(st.size), true);
        dv.setBigInt64(11, BigInt(st.mtimeMillis ?? 0), true);
      } catch { /* absent, and the zeroes say so */ }
      return out;
    },
    [OP.LINK_STAT]: async (p) => {
      const out = new Uint8Array(20);
      const dv = new DataView(out.buffer);
      if (!opts.fs?.read) return out;
      try {
        const path = P(unstr(p));
        const st = io.linkStat === undefined
          ? { ...(await io.stat(path)), isSymlink: false }
          : await io.linkStat(path);
        out[0] = 1;
        out[1] = st.isFile ? 1 : 0;
        out[2] = st.isDirectory ? 1 : 0;
        dv.setBigInt64(3, BigInt(st.size), true);
        dv.setBigInt64(11, BigInt(st.mtimeMillis ?? 0), true);
        out[19] = st.isSymlink ? 1 : 0;
      } catch { /* absent, and the zeroes say so */ }
      return out;
    },

    [OP.READ_DIR]: async (p) => {
      if (!opts.fs?.read) deny("filesystem read");
      const names = await io.readDir(P(unstr(p)));
      return str(names.join("\u0000"));
    },
    [OP.WRITE_FILE]: async (p) => {
      if (!opts.fs?.write) deny("filesystem write");
      const n = readI32le(p);
      await fs.writeFile(P(unstr(p.subarray(4, 4 + n))), p.subarray(4 + n));
      return EMPTY;
    },

    [OP.OPEN_INPUT]: async (p) => {
      const path = unstr(p);
      await source?.close();
      source = null;
      if (path === "") return EMPTY;
      if (!opts.fs?.read) deny("filesystem read");
      source = await io.openFile(P(path));
      return EMPTY;
    },
    [OP.READ_CHUNK]: async () => {
      const fed = source === null ? kids.readChunk() : null;
      if (fed !== null) return fed.length === 0 ? END : data(fed);
      try {
        const got = source === null ? await io.readStdinChunk() : await source.read();
        return got.length === 0 ? END : data(got);
      } catch (e) {
        return failed(e instanceof Error ? e.message : String(e));
      }
    },
    [OP.OUTPUT_ERROR]: () => str(outputFailure),

    [OP.OPEN_OUTPUT]: async (p) => {
      const path = unstr(p);
      await sink?.close();
      sink = null;
      if (path === "") return EMPTY;
      if (!opts.fs?.write) deny("filesystem write");
      sink = await io.createFile(P(path));
      return EMPTY;
    },

    [OP.CONNECT]: async (p) => {
      if (!opts.net) deny("network access");
      const c = await io.connect(unstr(p.subarray(4)), readI32le(p));
      const h = nextHandle++;
      sockets.set(h, c);
      return i32le(h);
    },
    [OP.LISTEN]: async (p) => {
      if (!opts.net) deny("network access");
      const l = await io.listen(readI32le(p));
      const h = nextHandle++;
      listeners.set(h, l);
      return i32le(h);
    },
    [OP.ACCEPT]: async (p) => {
      const l = listeners.get(readI32le(p));
      if (l === undefined) throw new Error("not a listening socket");
      const c = await l.accept();
      const h = nextHandle++;
      sockets.set(h, c);
      return i32le(h);
    },
    [OP.RECV]: async (p) => {
      const h = readI32le(p);
      // Handle 0 is standard input — see the note in `deno.ts`.
      if (h === 0) {
        const piped = await io.readStdinChunk();
        return piped.length === 0 ? END : data(piped);
      }
      const c = sockets.get(h);
      if (c === undefined) return failed("not an open socket");
      try {
        const got = await c.recv();
        return got.length === 0 ? END : data(got);
      } catch (e) {
        return failed(e instanceof Error ? e.message : String(e));
      }
    },
    [OP.SEND]: async (p) => {
      const c = sockets.get(readI32le(p));
      if (c === undefined) throw new Error("not an open socket");
      await c.send(p.subarray(4));
      return EMPTY;
    },
    [OP.CLOSE_SOCKET]: (p) => {
      const h = readI32le(p);
      try { sockets.get(h)?.close(); } catch { /* already closed */ }
      try { listeners.get(h)?.close(); } catch { /* already closed */ }
      sockets.delete(h);
      listeners.delete(h);
      return EMPTY;
    },

    [OP.MKDIR]: async (p) => {
      if (!opts.fs?.write) deny("filesystem write");
      await fs.mkdir(P(unstr(p.subarray(1))), { recursive: p[0] === 1 });
      return EMPTY;
    },
    [OP.REMOVE]: async (p) => {
      if (!opts.fs?.write) deny("filesystem write");
      // `force: false` so that removing something absent fails, as `Deno.remove` does.
      // Node's `rm` is otherwise happy to report success for a path that was never there.
      await fs.rm(P(unstr(p.subarray(1))), { recursive: p[0] === 1, force: false });
      return EMPTY;
    },
    [OP.RENAME]: async (p) => {
      if (!opts.fs?.write) deny("filesystem write");
      const n = readI32le(p);
      await fs.rename(P(unstr(p.subarray(4, 4 + n))), P(unstr(p.subarray(4 + n))));
      return EMPTY;
    },
  };
}
