// Deno's implementation of the world, on the main thread.
//
// Note how much of this is `await`. That is the reason the bridge exists: none of these
// are things wac could have called directly, and with the bridge the wac side does not
// know the difference.

import { type Handlers, serveHostCalls } from "./respond.ts";
import { ByteQueue, type Child, spawnChild } from "./children.ts";
import { bridgeOf, CHUNK, newBridge } from "./layout.ts";
import { i32le, i64le, readI32le, str, unstr } from "./call.ts";
import { OP } from "./ops.ts";

export type DenoWorldOptions = {
  /** Arguments the application sees. Defaults to none, not to the launcher's own. */
  args?: string[];
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
  readStdin?(): Promise<Uint8Array>;
};

const EMPTY = new Uint8Array(0);

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

export function denoWorld(opts: DenoWorldOptions = {}): Handlers {
  const args = opts.args ?? [];
  const log = opts.log ?? ((l: string) => console.log(l));
  const warn = opts.warn ?? ((l: string) => console.error(l));
  const deny = (what: string) => { throw new Error(`${what} not granted to this application`); };
  const writeOut = opts.write;
  const readIn = opts.readStdin;

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
  let nextHandle = 1;

  return {
    [OP.NOW_MILLIS]: () => i64le(BigInt(Date.now())),
    [OP.MONOTONIC_NANOS]: () => i64le(BigInt(Math.round(performance.now() * 1e6))),
    // A timer, which is what makes a timeout expressible: waited on beside another ticket,
    // whichever lands first decides. Resolves to the monotonic nanoseconds at which it fired
    // rather than to nothing, so a caller can see the overshoot.
    //
    // `unrefTimer` is deliberately absent: an outstanding timer holding the event loop open
    // is what keeps a worker parked on it from waiting forever.
    [OP.SLEEP_MILLIS]: (p) =>
      new Promise<Uint8Array>((ok) =>
        setTimeout(() => ok(i64le(BigInt(Math.round(performance.now() * 1e6)))), readI32le(p))
      ),
    [OP.RANDOM_BYTES]: (p) => {
      const n = readI32le(p);
      if (n < 0 || n > 1 << 20) throw new Error(`randomBytes(${n}) out of range`);
      return crypto.getRandomValues(new Uint8Array(n));
    },
    [OP.LOG]: (p) => { log(unstr(p)); return EMPTY; },
    [OP.WARN]: (p) => { warn(unstr(p)); return EMPTY; },

    [OP.ARG_COUNT]: () => i32le(args.length),
    [OP.ARG]: (p) => {
      const i = readI32le(p);
      return str(i >= 0 && i < args.length ? args[i] : "");
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
      return await Deno.readFile(unstr(p));
    },

    // stdin and stdout need no grant: what the user pipes in and what the program prints
    // are the user's own doing, not a reach into something they did not offer.
    [OP.READ_STDIN]: async () => readIn === undefined ? await readAllStdin() : await readIn(),
    [OP.WRITE_STDOUT]: async (p) => {
      if (writeOut !== undefined) { writeOut(p.slice()); return EMPTY; }
      if (sink === null) { await writeAllStdout(p); return EMPTY; }
      let at = 0;
      while (at < p.length) at += await sink.write(p.subarray(at));
      return EMPTY;
    },

    [OP.STAT]: async (p) => {
      const out = new Uint8Array(19);
      const dv = new DataView(out.buffer);
      if (!opts.fs?.read) return out; // not granted reads as "does not exist"
      try {
        const st = await Deno.stat(unstr(p));
        out[0] = 1;
        out[1] = st.isFile ? 1 : 0;
        out[2] = st.isDirectory ? 1 : 0;
        dv.setBigInt64(3, BigInt(st.size), true);
        dv.setBigInt64(11, BigInt(st.mtime?.getTime() ?? 0), true);
      } catch { /* absent, and the zeroes say so */ }
      return out;
    },
    [OP.READ_DIR]: async (p) => {
      if (!opts.fs?.read) deny("filesystem read");
      const names = await denoDir(unstr(p));
      return str(names.join("\u0000"));
    },
    [OP.WRITE_FILE]: async (p) => {
      if (!opts.fs?.write) deny("filesystem write");
      const n = readI32le(p);
      const path = unstr(p.subarray(4, 4 + n));
      await Deno.writeFile(path, p.subarray(4 + n));
      return EMPTY;
    },

    // The mutation tier. Each throws on failure and the wac side reads that as `false`,
    // so an application never has to tell "not permitted" from "did not exist" — which
    // is again the correct amount for it to know.
    [OP.OPEN_INPUT]: async (p) => {
      const path = unstr(p);
      source?.close();
      source = null;
      if (path === "") return EMPTY;      // standard input, and the default
      if (!opts.fs?.read) deny("filesystem read");
      source = await Deno.open(path, { read: true });
      return EMPTY;
    },
    [OP.READ_CHUNK]: async () => {
      if (source === null && readIn !== undefined) return await readIn();
      const into = fresh();
      const n = source === null ? await Deno.stdin.read(into) : await source.read(into);
      // A short read is not the end; only null is.
      return n === null ? EMPTY : into.subarray(0, n);
    },

    [OP.OPEN_OUTPUT]: async (p) => {
      const path = unstr(p);
      // Closed before the next one opens, so a program that has finished writing a file
      // can rename over it — see the note in platform.wac.
      sink?.close();
      sink = null;
      if (path === "") return EMPTY;
      if (!opts.fs?.write) deny("filesystem write");
      sink = await Deno.open(path, { write: true, create: true, truncate: true });
      return EMPTY;
    },

    [OP.CONNECT]: async (p) => {
      if (!opts.net) deny("network access");
      const port = readI32le(p);
      const conn = await Deno.connect({ hostname: unstr(p.subarray(4)), port });
      const h = nextHandle++;
      sockets.set(h, conn);
      return i32le(h);
    },
    [OP.LISTEN]: (p) => {
      if (!opts.net) deny("network access");
      const l = Deno.listen({ port: readI32le(p) });
      const h = nextHandle++;
      listeners.set(h, l);
      return i32le(h);
    },
    [OP.ACCEPT]: async (p) => {
      const l = listeners.get(readI32le(p));
      if (l === undefined) throw new Error("not a listening socket");
      const conn = await l.accept();
      const h = nextHandle++;
      sockets.set(h, conn);
      return i32le(h);
    },
    [OP.RECV]: async (p) => {
      const h = readI32le(p);
      // Handle 0 is standard input. Handles count from 1, so it can never be a socket, and
      // giving stdin one means `waitAny` can watch it beside a socket — which is what a
      // relay like `nc` needs and could not express while stdin was only `readChunk`.
      if (h === STDIN_HANDLE && readIn !== undefined) return await readIn();
      const into = fresh();
      if (h === STDIN_HANDLE) {
        const n = await Deno.stdin.read(into);
        return n === null ? EMPTY : into.subarray(0, n);
      }
      const kid = children.get(h);
      if (kid !== undefined) return await kid.out.next();
      const c = sockets.get(h);
      if (c === undefined) throw new Error("not an open socket");
      const n = await c.read(into);
      return n === null ? EMPTY : into.subarray(0, n);
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
     */
    [OP.SPAWN]: (p) => {
      const n = readI32le(p);
      const source = unstr(p.subarray(4, 4 + n));
      const rest = unstr(p.subarray(4 + n));
      const childArgs = rest.length === 0 ? [] : rest.split("\u0000");
      const h = nextHandle++;
      children.set(h, spawnChild(source, childArgs, (sab, cargs, out, input) => {
        const enc = new TextEncoder();
        return serveHostCalls(bridgeOf(sab), denoWorld({
          args: cargs,
          // A line of output is bytes on the handle, with the newline `log` implies. The
          // parent cannot tell `log` from `write` — nor can a pipe, which is the point.
          log: (l: string) => out.push(enc.encode(l + "\n")),
          warn: (l: string) => out.push(enc.encode(l + "\n")),
          write: (b: Uint8Array) => out.push(b),
          readStdin: () => input.next(),
        }));
      }, newBridge));
      return i32le(h);
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

    [OP.MKDIR]: async (p) => {
      if (!opts.fs?.write) deny("filesystem write");
      await Deno.mkdir(unstr(p.subarray(1)), { recursive: p[0] === 1 });
      return EMPTY;
    },
    [OP.REMOVE]: async (p) => {
      if (!opts.fs?.write) deny("filesystem write");
      await Deno.remove(unstr(p.subarray(1)), { recursive: p[0] === 1 });
      return EMPTY;
    },
    [OP.RENAME]: async (p) => {
      if (!opts.fs?.write) deny("filesystem write");
      const n = readI32le(p);
      await Deno.rename(unstr(p.subarray(4, 4 + n)), unstr(p.subarray(4 + n)));
      return EMPTY;
    },
  };
}
