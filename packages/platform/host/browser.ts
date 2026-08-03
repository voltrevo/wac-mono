// The world in a page.
//
// The bridge needed nothing: `layout.ts`, `call.ts` and `respond.ts` contain no reference
// to any host at all, and a page with a worker is exactly the shape they already assume —
// a thread that may block and a thread that may not. What differs is which capabilities
// can be honoured, and that is the interesting part of this file rather than the plumbing.
//
// **Three do not survive the translation, and are refused rather than approximated:**
//
//   - `connect`, `listen`, `accept` — a page has no TCP. `fetch` is not a socket and a
//     WebSocket is not either; pretending otherwise would give an application a `connect`
//     that works for one protocol and silently fails for the rest. `box get` therefore
//     does not run here and `box serve` never will.
//   - `readStdin` — there is no standard input. Empty, always, which is what a program
//     with nothing piped in already handles.
//   - `env` — every variable is unset. A page has no environment, and inventing one from
//     the query string would make `env("PATH")` mean something it does not.
//
// What survives: the clock, randomness, logging, arguments (from the query string), byte
// output (into the page), and the filesystem — through the Origin Private File System,
// which is a real hierarchical filesystem that happens to be origin-scoped.
//
// One promise a page cannot keep: OPFS has no rename, so `rename` is a copy and a delete.
// That is not atomic, and atomicity is the whole reason `rename` exists — see the note in
// platform.wac. An application relying on it for a safe write is weaker here, and there
// is no way to fix that from this side.
//
// `SharedArrayBuffer` requires the page to be cross-origin isolated: the server must send
// `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
// require-corp`. Without them `newBridge()` throws before anything else, so the launcher
// checks `crossOriginIsolated` first and says which headers are missing.

import { type Handlers } from "./respond.ts";
import { CHUNK } from "./layout.ts";
import { i32le, i64le, readI32le, str, unstr } from "./call.ts";
import { OP } from "./ops.ts";

const EMPTY = new Uint8Array(0);

// The File System Access API, described rather than imported — the same discipline
// `node.ts` uses for `node:worker_threads`, and for the same reason: this file has to
// type-check under Deno, whose default library does not declare it. Only what is used.

export type FileHandle = {
  getFile(): Promise<Blob & { size: number; lastModified: number }>;
  createWritable(): Promise<WritableFile>;
};

export type WritableFile = {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
};

export type DirHandle = {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterable<string>;
};

/** What the page gives the application. Everything is optional, and absent means denied. */
export type BrowserWorldOptions = {
  /** Arguments the application sees. The launcher reads these from the query string. */
  args?: string[];
  /** Where `log` and `warn` go. Defaults to the console. */
  log?(line: string): void;
  warn?(line: string): void;
  /** Where `write` goes — exact bytes, no newline. Defaults to the console, as text. */
  write?(bytes: Uint8Array): void;
  /**
   * The Origin Private File System root, if the page is willing to grant one.
   *
   * Absent means no filesystem at all, exactly as omitting `fs` does under Deno. Passing
   * a *subdirectory* handle rather than the origin root is how a page gives one
   * application its own corner of the filesystem.
   */
  root?: DirHandle;
  /** Whether writes are allowed, when a root is granted at all. */
  writable?: boolean;
};

/** A path resolved to the directory that holds it, and its last component. */
type Resolved = { dir: DirHandle; name: string };

export function browserWorld(opts: BrowserWorldOptions = {}): Handlers {
  const args = opts.args ?? [];
  const log = opts.log ?? ((l: string) => console.log(l));
  const warn = opts.warn ?? ((l: string) => console.warn(l));
  const write = opts.write ?? ((b: Uint8Array) => console.log(new TextDecoder().decode(b)));
  const deny = (what: string): never => {
    throw new Error(`${what} not granted to this application`);
  };

  const root = (): DirHandle => opts.root ?? deny("filesystem read");
  const canWrite = (): void => {
    if (opts.root === undefined || opts.writable !== true) deny("filesystem write");
  };

  /**
   * Walk a path to the directory holding its last component.
   *
   * Leading and repeated slashes are dropped rather than treated as absolute: paths are
   * relative to the root the application was given, and there is nothing above that root
   * for them to be absolute about.
   */
  const resolve = async (path: string, create: boolean): Promise<Resolved> => {
    const parts = path.split("/").filter((p) => p !== "" && p !== ".");
    if (parts.length === 0) throw new Error("empty path");
    let dir = root();
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create });
    }
    return { dir, name: parts[parts.length - 1] };
  };

  const fileOf = async (path: string) => {
    const { dir, name } = await resolve(path, false);
    return await (await dir.getFileHandle(name)).getFile();
  };

  // The current streaming input and output: the same one-at-a-time model the other worlds
  // use, for the reason given in platform.wac — a handle cannot be carried into a funcref.
  let source: { blob: Blob; at: number } | null = null;
  let sink: WritableFile | null = null;

  return {
    [OP.NOW_MILLIS]: () => i64le(BigInt(Date.now())),
    [OP.MONOTONIC_NANOS]: () => i64le(BigInt(Math.round(performance.now() * 1e6))),
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
    // Unset, always. One byte of presence says so, as it does everywhere else.
    [OP.ENV]: () => new Uint8Array([0]),

    [OP.READ_STDIN]: () => EMPTY,
    [OP.WRITE_STDOUT]: async (p) => {
      if (sink === null) { write(p); return EMPTY; }
      await sink.write(p);
      return EMPTY;
    },

    [OP.READ_FILE]: async (p) => new Uint8Array(await (await fileOf(unstr(p))).arrayBuffer()),
    [OP.WRITE_FILE]: async (p) => {
      canWrite();
      const n = readI32le(p);
      const { dir, name } = await resolve(unstr(p.subarray(4, 4 + n)), true);
      const h = await dir.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(p.subarray(4 + n));
      await w.close();
      return EMPTY;
    },
    [OP.STAT]: async (p) => {
      const out = new Uint8Array(19);
      const dv = new DataView(out.buffer);
      if (opts.root === undefined) return out;   // not granted reads as "does not exist"
      const path = unstr(p);
      try {
        const f = await fileOf(path);
        out[0] = 1;
        out[1] = 1;
        dv.setBigInt64(3, BigInt(f.size), true);
        dv.setBigInt64(11, BigInt(f.lastModified), true);
        return out;
      } catch { /* not a file; try a directory */ }
      try {
        const { dir, name } = await resolve(path, false);
        await dir.getDirectoryHandle(name);
        out[0] = 1;
        out[2] = 1;
      } catch { /* absent, and the zeroes say so */ }
      return out;
    },
    [OP.READ_DIR]: async (p) => {
      const { dir, name } = await resolve(unstr(p), false);
      const h = await dir.getDirectoryHandle(name);
      const names: string[] = [];
      for await (const key of h.keys()) { names.push(key); }
      // NUL, as the other two worlds do. Joining on a space would split "my file"
      // into two entries, and only in a browser — the worst place for it to differ.
      return str(names.sort().join("\u0000"));
    },

    [OP.MKDIR]: async (p) => {
      canWrite();
      const path = unstr(p.subarray(1));
      if (p[0] === 1) {
        const { dir, name } = await resolve(path, true);   // -p: every component
        await dir.getDirectoryHandle(name, { create: true });
        return EMPTY;
      }
      const { dir, name } = await resolve(path, false);
      // Without `-p`, a missing parent must fail — which `resolve(false)` does — and so
      // must an existing directory. OPFS has no exclusive create, so it is asked first.
      let exists = true;
      try { await dir.getDirectoryHandle(name); } catch { exists = false; }
      if (exists) throw new Error("already exists");
      await dir.getDirectoryHandle(name, { create: true });
      return EMPTY;
    },
    [OP.REMOVE]: async (p) => {
      canWrite();
      const { dir, name } = await resolve(unstr(p.subarray(1)), false);
      await dir.removeEntry(name, { recursive: p[0] === 1 });
      return EMPTY;
    },
    [OP.RENAME]: async (p) => {
      canWrite();
      const n = readI32le(p);
      const from = unstr(p.subarray(4, 4 + n));
      const to = unstr(p.subarray(4 + n));
      // OPFS has no rename, so this is a copy and a delete — **not atomic**, which is the
      // one promise a page cannot keep. See the file header.
      const bytes = new Uint8Array(await (await fileOf(from)).arrayBuffer());
      const dst = await resolve(to, true);
      const h = await dst.dir.getFileHandle(dst.name, { create: true });
      const w = await h.createWritable();
      await w.write(bytes);
      await w.close();
      const src = await resolve(from, false);
      await src.dir.removeEntry(src.name);
      return EMPTY;
    },

    [OP.OPEN_INPUT]: async (p) => {
      const path = unstr(p);
      source = null;
      if (path === "") return EMPTY;             // "standard input", which is empty here
      source = { blob: await fileOf(path), at: 0 };
      return EMPTY;
    },
    [OP.READ_CHUNK]: async () => {
      if (source === null) return EMPTY;
      const end = Math.min(source.at + CHUNK, source.blob.size);
      if (end <= source.at) return EMPTY;
      const slice = source.blob.slice(source.at, end);
      source.at = end;
      return new Uint8Array(await slice.arrayBuffer());
    },
    [OP.OPEN_OUTPUT]: async (p) => {
      const path = unstr(p);
      if (sink !== null) { await sink.close(); sink = null; }
      if (path === "") return EMPTY;
      canWrite();
      const { dir, name } = await resolve(path, true);
      sink = await (await dir.getFileHandle(name, { create: true })).createWritable();
      return EMPTY;
    },

    // No TCP in a page, and no honest approximation of one.
    [OP.CONNECT]: () => deny("network access"),
    [OP.LISTEN]: () => deny("network access"),
    [OP.ACCEPT]: () => deny("network access"),
    // Handle 0 is standard input everywhere else; a page has none, so it ends immediately
    // rather than refusing. Any other handle is a socket, which a page cannot have.
    [OP.RECV]: (p) => (readI32le(p) === 0 ? EMPTY : deny("network access")),
    [OP.SEND]: () => deny("network access"),
    [OP.CLOSE_SOCKET]: () => EMPTY,
  };
}
