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
import { ChildStack, packCaptured, unpackPush } from "./child.ts";

const EMPTY = new Uint8Array(0);

/** A `warn` payload as a line of a captured error stream: its bytes, then a newline. */
function lineOf(p: Uint8Array): Uint8Array {
  const out = new Uint8Array(p.length + 1);
  out.set(p, 0);
  out[p.length] = 10;
  return out;
}

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
  /**
   * The page itself, if the application is an interactive one.
   *
   * Injected rather than reached for, the same way `root` is, and for the same two reasons:
   * this module then contains no reference to `document` and can be tested against a double,
   * and a page that wants to give an application one corner of itself can pass a `Dom` scoped
   * to that corner. Absent means every `Page` capability is refused.
   */
  dom?: Dom;
};

/**
 * What a page has to be able to do for an interactive application.
 *
 * Deliberately small and string-shaped. An element is a live object on the other side of a
 * thread; a capability that handed one back would be handing back something this side cannot
 * hold, so everything here is named by id or selector and answers with text.
 */
export type Dom = {
  render(html: string): void;
  setText(id: string, text: string): void;
  setValue(id: string, value: string): void;
  value(id: string): string;
  /** Subscribe, delegated from the document so it survives a `render`. */
  on(selector: string, kind: string): void;
  title(text: string): void;
  /** The next event, waiting for one. One waiter, like a child's output queue. */
  next(): Promise<{ kind: string; id: string; value: string; x: number; y: number }>;
  /** Blit `w * h * 4` bytes of RGBA into a canvas, resizing it to match. */
  drawPixels(id: string, w: number, h: number, rgba: Uint8Array): void;
  /** The next file the user picks or drops, waiting for one. */
  nextFile(): Promise<{ ok: boolean; name: string; bytes: Uint8Array; error: string }>;
  /** Hand bytes back to the user as a download. */
  offerDownload(name: string, bytes: Uint8Array): void;
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
  /** The page, or a refusal naming what is missing rather than a TypeError. */
  const dom = (): Dom => {
    if (opts.dom === undefined) deny("the page");
    return opts.dom as Dom;
  };

  /** A length-prefixed string followed by the rest, which is how two strings cross. */
  const twoStrings = (p: Uint8Array): [string, string] => {
    const n = readI32le(p);
    return [unstr(p.subarray(4, 4 + n)), unstr(p.subarray(4 + n))];
  };

  // A program running inside this one. Both path walkers above go through `kids.path`, so a
  // child's relative paths resolve from where the shell put it; with nothing pushed it is the
  // identity and every path means exactly what it did before.
  const kids = new ChildStack();
  // Empty until a read fails; `inputError` hands it back. See platform.wac.
  let inputFailure = "";
  // The same for the other two directions: a `write` that failed, and the last failure per socket.
  // Recorded rather than only thrown, because `write` answers a bool and `recv` answers bytes —
  // neither can carry a reason. See `outputError` and `socketError` in platform.wac.
  let outputFailure = "";
  const socketFailure = new Map<number, string>();

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
    const parts = kids.path(path).split("/").filter((p) => p !== "" && p !== ".");
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

  /**
   * The directory a path names, where naming nothing names the root.
   *
   * Separate from `resolve`, which answers with a directory and a *last component* and so
   * cannot express the root at all — it throws "empty path". That is right for `readFile` and
   * `writeFile`, which always have a component to open, and wrong for `readDir` and `stat`,
   * where `.` is the ordinary way to say "here".
   *
   * `readDir(".")` returning "not a directory" is what running this in a real browser found,
   * after the in-memory double in `browser.test.ts` had been happy for a week: OPFS has no `.`
   * entry, so the filter dropped it, the parts list came out empty, and the throw became a null
   * the application read as "no such directory". Deno and Node both answer `.` with the
   * listing, so portable code asked the obvious question and silently got nothing.
   */
  const dirOf = async (path: string, create: boolean): Promise<DirHandle> => {
    const parts = kids.path(path).split("/").filter((x) => x !== "" && x !== ".");
    let dir = root();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return dir;
  };

  /** What `stat` and `linkStat` both answer with: the twenty bytes `provider.ts` decodes. */
  const statBytes = async (path: string): Promise<Uint8Array> => {
    const out = new Uint8Array(20);
    const dv = new DataView(out.buffer);
    if (opts.root === undefined) return out;   // not granted reads as "does not exist"
    try {
      const f = await fileOf(path);
      out[0] = 1;
      out[1] = 1;
      dv.setBigInt64(3, BigInt(f.size), true);
      dv.setBigInt64(11, BigInt(f.lastModified), true);
      return out;
    } catch { /* not a file; try a directory */ }
    try {
      await dirOf(path, false);   // the root included, which `resolve` cannot express
      out[0] = 1;
      out[2] = 1;
    } catch { /* absent, and the zeroes say so */ }
    return out;
  };

  // The current streaming input and output: the same one-at-a-time model the other worlds
  // use, for the reason given in platform.wac — a handle cannot be carried into a funcref.
  let source: { blob: Blob; at: number } | null = null;
  let sink: WritableFile | null = null;

  return {
    [OP.NOW_MILLIS]: () => i64le(BigInt(Date.now())),
    [OP.MONOTONIC_NANOS]: () => i64le(BigInt(Math.round(performance.now() * 1e6))),
    // A timer, which is what makes a timeout expressible: waited on beside another ticket,
    // whichever lands first decides. Resolves to the monotonic nanoseconds at which it fired
    // rather than to nothing, so a caller can see the overshoot.
    // ── The page ──────────────────────────────────────────────────────────────
    // Refused rather than ignored when no `dom` was given: an application that thinks it has
    // drawn something and has not is worse off than one told it cannot draw.
    [OP.RENDER]: (p) => { dom().render(unstr(p)); return EMPTY; },
    [OP.SET_TEXT]: (p) => { const [a, b] = twoStrings(p); dom().setText(a, b); return EMPTY; },
    [OP.SET_VALUE]: (p) => { const [a, b] = twoStrings(p); dom().setValue(a, b); return EMPTY; },
    [OP.GET_VALUE]: (p) => str(dom().value(unstr(p))),
    [OP.ON]: (p) => { const [a, b] = twoStrings(p); dom().on(a, b); return EMPTY; },
    [OP.TITLE]: (p) => { dom().title(unstr(p)); return EMPTY; },
    [OP.NEXT_EVENT]: async () => {
      const e = await dom().next();
      // NUL-separated fields, in the order `Event` declares them. None can contain a NUL: two
      // are an id and an event kind, one is an input's value, and two are numbers.
      return str(`${e.kind}\u0000${e.id}\u0000${e.value}\u0000${e.x}\u0000${e.y}`);
    },
    [OP.DRAW_PIXELS]: (p) => {
      const w = readI32le(p);
      const h = readI32le(p.subarray(4));
      const n = readI32le(p.subarray(8));
      const id = unstr(p.subarray(12, 12 + n));
      const rgba = p.subarray(12 + n);
      // Checked here rather than trusted: a short buffer would otherwise be a confusing
      // DOMException from `putImageData`, several layers from the wac that got it wrong.
      if (rgba.length !== w * h * 4) {
        throw new Error(`drawPixels: ${w}x${h} needs ${w * h * 4} bytes, got ${rgba.length}`);
      }
      dom().drawPixels(id, w, h, rgba);
      return EMPTY;
    },
    [OP.NEXT_FILE]: async () => {
      const f = await dom().nextFile();
      // A flag, the name length-prefixed, then the bytes — the name can hold anything but a
      // NUL, and so can an error message, so neither can be a separator here.
      const name = str(f.name);
      const err = str(f.error);
      const out = new Uint8Array(1 + 4 + name.length + 4 + err.length + f.bytes.length);
      out[0] = f.ok ? 1 : 0;
      out.set(i32le(name.length), 1);
      out.set(name, 5);
      out.set(i32le(err.length), 5 + name.length);
      out.set(err, 9 + name.length);
      out.set(f.bytes, 9 + name.length + err.length);
      return out;
    },
    [OP.OFFER_DOWNLOAD]: (p) => {
      const n = readI32le(p);
      dom().offerDownload(unstr(p.subarray(4, 4 + n)), p.subarray(4 + n));
      return EMPTY;
    },

    // A page has no process directory. The root of the Origin Private File System is where its
    // relative paths land, so that is the true answer and not a placeholder.
    [OP.CWD]: () => str("/"),
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
    // Unset, always. One byte of presence says so, as it does everywhere else.
    [OP.ENV]: () => new Uint8Array([0]),

    // A page has no standard input of its own; a child running inside it does.
    [OP.READ_STDIN]: () => kids.readAll() ?? EMPTY,
    [OP.WRITE_STDOUT]: async (p) => {
      if (kids.active) {
        if (!kids.write(p)) throw new Error("the child's output buffer is full");
        return EMPTY;
      }
      try {
        if (sink === null) { write(p); return EMPTY; }
        await sink.write(p);
        return EMPTY;
      } catch (e) {
        // A page has no pipe to break, so any failure here is a real one — a quota exceeded, or a
        // handle the browser took back. Recorded so `outputError` can say which.
        outputFailure = e instanceof Error ? e.message : String(e);
        throw e;
      }
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
    [OP.STAT]: (p) => statBytes(unstr(p)),
    // The Origin Private File System has no symbolic links, so this *is* `stat`, and `isSymlink`
    // stays false. That is true rather than a stand-in — and it is why `tar` can refuse links in a
    // page as well, without knowing which host it is on.
    [OP.LINK_STAT]: (p) => statBytes(unstr(p)),

    [OP.READ_DIR]: async (p) => {
      const h = await dirOf(unstr(p), false);
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
      const fed = source === null ? kids.readChunk() : null;
      if (fed !== null) return fed;
      if (source === null) return EMPTY;
      try {
        const end = Math.min(source.at + CHUNK, source.blob.size);
        if (end <= source.at) return EMPTY;
        const slice = source.blob.slice(source.at, end);
        source.at = end;
        return new Uint8Array(await slice.arrayBuffer());
      } catch (e) {
        inputFailure = e instanceof Error ? e.message : String(e);
        return EMPTY;
      }
    },
    // Why the last read gave nothing — see `inputError` in platform.wac.
    [OP.INPUT_ERROR]: () => str(inputFailure),
    [OP.OUTPUT_ERROR]: () => str(outputFailure),
    [OP.SOCKET_ERROR]: (p) => str(socketFailure.get(readI32le(p)) ?? ""),
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
