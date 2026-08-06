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
import { EMPTY_ARG, argBytes, i32le, i64le, readI32le, str, unstr } from "./call.ts";
import { GRANT_READ, GRANT_WRITE, OP } from "./ops.ts";
import { ChildStack, joinPath, packCaptured, unpackPush } from "./child.ts";
import { ByteQueue } from "./queue.ts";
import {
  type Child,
  failedChild,
  noSpawnHere,
  spawnChild,
  twoHandles,
  unpackSpawn,
  unpackSpawnSelf,
  want,
} from "./children.ts";
import { bridgeOf, newBridge } from "./layout.ts";
import { serveHostCalls } from "./respond.ts";
import {
  CHANGED_OK,
  FAULT_EXISTS,
  FAULT_NOT_GRANTED,
  Faulted,
  STAT_BYTES,
  STAT_FAULT,
  changeBytes,
  changed,
  faultOf,
  phraseOf,
} from "./faults.ts";

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
  /**
   * The program's arguments.
   *
   * Strings are accepted because that is what a launcher has — `Deno.args` is already text, and an
   * operating system that handed us bytes gave them to the runtime first. Bytes are accepted because a
   * *parent* has them exactly, and a spawned child must receive what its parent sent rather than a
   * UTF-8 round trip of it. wac-mono 0065.
   */
  args?: (string | Uint8Array)[];
  /** Where `log` and `warn` go. Defaults to the console. */
  log?(line: string): void;
  warn?(line: string): void;
  /** Where `write` goes — exact bytes, no newline. Defaults to the console, as text. */
  write?(bytes: Uint8Array): void;
  /**
   * Where `writeErr` goes — exact bytes on the error stream, no newline.
   *
   * Defaults to `warn`'s destination decoded as text, because a page that has somewhere to put
   * diagnostics has somewhere to put these; a page that wants them apart passes this.
   */
  writeErr?(bytes: Uint8Array): void;
  /**
   * Where standard input comes from. A page has none; a *spawned child* does — what its parent
   * sent — and this is how the queue reaches it. The same option the Deno host takes, for the same
   * reason and with the same shape.
   */
  readStdin?(): Promise<Uint8Array>;
  /**
   * One chunk of standard input, for `readChunk` and `recv(0)`.
   *
   * Separate from `readStdin` because they promise different things — everything, and something —
   * and for a spawned child the difference is the difference between sorting its input and sorting
   * the first line of it.
   */
  readStdinChunk?(): Promise<Uint8Array>;
  /**
   * This program's own worker bundle, for `spawnSelf`.
   *
   * The launcher has it — it is what started the program — and `runInPage` passes it along. Absent
   * means `spawnSelf` says there is no spawn here rather than failing a program.
   */
  selfSource?: string;
  /**
   * Where relative paths resolve from, and what `cwd` reports.
   *
   * A page's own is `/`, the root of its Origin Private File System. A *child's* is whatever started
   * it said, which is how `cd sub; prog f` means `sub/f` in a browser terminal too.
   */
  cwd?: string;
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
  const readIn = opts.readStdin;
  const readChunkIn = opts.readStdinChunk ?? opts.readStdin;

  /**
   * The children this page has started, by handle.
   *
   * Numbered from 1 so that 0 is standard input, as it is in every host — handles are one namespace
   * and `waitAny` watches them without knowing which is which.
   */
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

  /**
   * Start a child on `source`, with `want` narrowed to what this page itself was given.
   *
   * Shared by `spawn` and `spawnSelf`, which differ only in where the source comes from. A child
   * gets no `dom`: its output reaches the parent through its handle, and a child that could draw
   * would be drawing over the program that started it.
   */
  const startChild = async (
    source: string,
    childArgs: Uint8Array[],
    wanted: number,
    childCwd: string,
    inheritIn: boolean,
  ): Promise<Uint8Array> => {
    const give = {
      read: (wanted & GRANT_READ) !== 0 && opts.root !== undefined,
      write: (wanted & GRANT_WRITE) !== 0 && opts.root !== undefined && opts.writable === true,
    };
    const h = nextHandle++;
    const child = spawnChild(source, childArgs, (sab, cargs, out, input, cerr) => {
      const enc = new TextEncoder();
      return serveHostCalls(bridgeOf(sab), browserWorld({
        args: cargs,
        // A line of output is bytes on the handle, with the newline `log` implies. The parent cannot
        // tell `log` from `write`, and neither can a pipe — which is the point.
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
        // **An inheriting child reads the real thing.** Leaving these out is what hands it over: a
        // world with no `readStdin` option falls back to the process's own input, so the child reads
        // the same stream its parent would have — streaming rather than buffered, and *shared*, which
        // is why `cat; cat` sees one line between them rather than one each. Issue 0042.
        ...(inheritIn ? {} : {
          readStdin: () => input.rest(),
          readStdinChunk: () => input.next(),
        }),
        ...(give.read ? { root: opts.root, writable: give.write } : {}),
        // So that a child can run itself too: the bundle is the same one.
        selfSource: opts.selfSource,
        // Where its relative paths resolve from. A shell in a tab that has done `cd sub` starts its
        // children there, exactly as it would on a command line.
        cwd: childCwd === "" ? opts.cwd : childCwd,
      }));
    }, newBridge);

    const why = await child.loaded;
    if (why !== "") {
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
  const writeErr = opts.writeErr ??
    ((b: Uint8Array) => warn(new TextDecoder().decode(b)));
  /**
   * A capability this page was not given, said in the host's own words and *kept* in them.
   *
   * `Faulted` rather than a plain `Error` so that the phrase policy below can tell the two apart. This
   * is a `Denied`, and rephrasing it to "permission denied" loses the only useful thing about it: that
   * the *page* withheld the capability, not that a filesystem refused an operation. The existing
   * denial test caught exactly that when the read path started rephrasing.
   */
  const deny = (what: string): never => {
    throw new Faulted(FAULT_NOT_GRANTED, `${what} not granted to this application`);
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
  // `write` answers a bool and cannot carry a reason, so this is recorded for `outputError`. The
  // reads no longer need an equivalent: `Read` carries theirs.
  let outputFailure = "";

  const canWrite = (): void => {
    if (opts.root === undefined || opts.writable !== true) deny("filesystem write");
  };

  /**
   * How this host says a failure: the category's phrase where it has one, and the exception's own
   * message where it does not.
   *
   * A `DOMException` message is written for a developer console — "A requested file or directory
   * could not be found at the time an operation was processed." — and a shell prints it after
   * `rm: cannot remove 'f': `, where it reads as a defect rather than as a diagnostic. The category
   * is already known by then, so the short form loses nothing. `FAULT_OTHER` keeps the message,
   * because there the message is the only information there is.
   */
  const describeAsPhrase = (fault: number, message: string): string => {
    const phrase = phraseOf(fault);
    return phrase === "" ? message : phrase;
  };

  /**
   * Run a read, and say a failure the way a change says it.
   *
   * A read reports by *throwing*: the bridge turns that into an error reply and the worker decodes it
   * into `FileResult.error` or `openInput`'s message. So the rephrasing has to happen here, and without
   * it a page spoke with two voices — `rm nosuchfile` said "no such file or directory" while
   * `cat nosuchfile` said "A requested file or directory could not be found at the time an operation was
   * processed.", which is the same failure in the same tab. Found by driving the browser terminal after
   * the change side was done. Issue 0025's phrase policy, one layer over.
   */
  const readOrPhrase = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (e) {
      // A fault this host named itself keeps its own words: those are chosen, and the phrase would be
      // a worse version of them. Everything else is the browser's boilerplate.
      if (e instanceof Faulted) throw e;
      const message = e instanceof Error ? e.message : String(e);
      // `Faulted`, not a plain `Error`: the category is *known* here, and throwing it plain would leave
      // the responder to recover it from my own English — which is the guess `faults.ts` exists to
      // avoid, and it now matters, because the category rides the error envelope to the program
      // (wac-mono 0062).
      throw new Faulted(faultOf(e), describeAsPhrase(faultOf(e), message));
    }
  };

  /**
   * The same question as `canWrite`, for the four operations that answer with a `Change` instead of
   * throwing: a refusal is a `Denied` fault said in the ordinary shape, not an exception.
   */
  const writeRefused = (): Uint8Array | null =>
    opts.root === undefined || opts.writable !== true
      ? changeBytes(FAULT_NOT_GRANTED, "filesystem write not granted to this application")
      : null;

  /**
   * Walk a path to the directory holding its last component.
   *
   * Leading and repeated slashes are dropped rather than treated as absolute: paths are
   * relative to the root the application was given, and there is nothing above that root
   * for them to be absolute about.
   */
  const resolve = async (path: string, create: boolean): Promise<Resolved> => {
    const parts = joinPath(opts.cwd ?? "", kids.path(path)).split("/").filter((p) => p !== "" && p !== ".");
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
    const parts = joinPath(opts.cwd ?? "", kids.path(path)).split("/").filter((x) => x !== "" && x !== ".");
    let dir = root();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return dir;
  };

  /** What `stat` and `linkStat` both answer with: the twenty bytes `provider.ts` decodes. */
  const statBytes = async (path: string): Promise<Uint8Array> => {
    const out = new Uint8Array(STAT_BYTES);
    const dv = new DataView(out.buffer);
    // No root is no read capability, which is not the same as an empty filesystem — a page that was never
    // given a directory cannot say whether a file is there, and saying "it is not" is a guess.
    if (opts.root === undefined) {
      out[STAT_FAULT] = FAULT_NOT_GRANTED;
      return out;
    }
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
    [OP.CWD]: () => str(opts.cwd !== undefined && opts.cwd !== "" ? opts.cwd : "/"),
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
      // The bytes, unchanged. A program that wants text says `string.fromBytes` on its own side.
      return i >= 0 && i < own.length ? argBytes(own[i]) : EMPTY_ARG;
    },
    // Unset, always. One byte of presence says so, as it does everywhere else.
    [OP.ENV]: () => new Uint8Array([0]),

    // A page has no standard input of its own; a child running inside it does.
    [OP.READ_STDIN]: async () => kids.readAll() ?? (readIn === undefined ? EMPTY : await readIn()),
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

    /**
     * Standard error as bytes. A page has one place for text, so this reaches the same sink `warn`
     * does — but without a newline, and without going through a string, so bytes that are not valid
     * UTF-8 survive as far as the page's own decoder rather than being mangled here.
     */
    [OP.WRITE_STDERR]: (p) => {
      if (kids.active) { kids.warn(p); return EMPTY; }
      writeErr(p);
      return EMPTY;
    },

    /**
     * A worker on the source it is handed, with a world of its own. Issue 0030.
     *
     * Nothing about a page forbade this: a worker can create a worker, each program needs its own
     * `SharedArrayBuffer` and a responder for it, and the page's own thread can host a second
     * responder as easily as the first. The parent is parked in `Atomics.wait` while its child runs,
     * and that is fine precisely because the child's calls are answered *here*, by the page, not by
     * the parent.
     *
     * The same `spawnChild` the Deno host uses, with a browser world instead of a Deno one — which
     * is the whole reason that function takes its world and its worker as arguments. What differs
     * between the two hosts is which world a child gets, and that is one expression.
     *
     * **A child gets no page.** Its `log`, `warn`, `write` and `writeErr` go to the parent through
     * the handle, its reads come from what the parent sends, and `dom` is deliberately absent: a
     * child that could draw would be drawing over the program that started it, and a handle is not
     * a place to put a canvas.
     */
    [OP.SPAWN]: (p) => {
      const { source, args, cwd, inheritIn } = unpackSpawn(p);
      return startChild(source, args, want(p), cwd, inheritIn);
    },

    /**
     * This same page's program again, with different arguments. See `spawnSelf` in platform.wac.
     *
     * **This is what gives a page programs to run at all.** `spawn` needs a bundle from a filesystem,
     * and a browser tab has no directory of programs — so a page could spawn and had nothing to
     * spawn. The launcher already holds this program's bundle, because it is what started it, and
     * `packages/box` decides which applet it is from its first argument. Issue 0030.
     */
    [OP.SPAWN_SELF]: (p) => {
      if (opts.selfSource === undefined) {
        return noSpawnHere("this page did not pass the program its own source");
      }
      const { args, cwd, inheritIn } = unpackSpawnSelf(p);
      return startChild(opts.selfSource, args, want(p), cwd, inheritIn);
    },

    [OP.CLOSE_FEED]: (p) => {
      // Input only. `closeSocket` is what stops a child; a program that reads to the end before
      // answering needs that end while it is still alive.
      children.get(readI32le(p))?.in.end();
      return EMPTY;
    },
    [OP.EXIT_CODE]: async (p) => {
      const c = children.get(readI32le(p));
      if (c === undefined) throw new Error("not a spawned worker");
      return i32le(await c.exit);
    },

    [OP.READ_FILE]: (p) =>
      readOrPhrase(async () => new Uint8Array(await (await fileOf(unstr(p))).arrayBuffer())),
    [OP.WRITE_FILE]: (p) => {
      const no = writeRefused();
      if (no !== null) return no;
      const n = readI32le(p);
      return changed(async () => {
        const { dir, name } = await resolve(unstr(p.subarray(4, 4 + n)), true);
        const h = await dir.getFileHandle(name, { create: true });
        const w = await h.createWritable();
        await w.write(p.subarray(4 + n));
        await w.close();
      }, describeAsPhrase);
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

    [OP.MKDIR]: (p) => {
      const no = writeRefused();
      if (no !== null) return no;
      const path = unstr(p.subarray(1));
      if (p[0] === 1) {
        return changed(async () => {
          const { dir, name } = await resolve(path, true);   // -p: every component
          await dir.getDirectoryHandle(name, { create: true });
        }, describeAsPhrase);
      }
      return changed(async () => {
        const { dir, name } = await resolve(path, false);
        // Without `-p`, a missing parent must fail — which `resolve(false)` does — and so
        // must an existing directory. OPFS has no exclusive create, so it is asked first.
        let exists = true;
        try { await dir.getDirectoryHandle(name); } catch { exists = false; }
        // `AlreadyExists` by name, because OPFS reports nothing here and the message is mine:
        // a caller asking "did it already exist" must not have to read my English.
        if (exists) throw new Faulted(FAULT_EXISTS, "already exists");
        await dir.getDirectoryHandle(name, { create: true });
      }, describeAsPhrase);
    },
    [OP.REMOVE]: (p) => {
      const no = writeRefused();
      if (no !== null) return no;
      return changed(async () => {
        const { dir, name } = await resolve(unstr(p.subarray(1)), false);
        await dir.removeEntry(name, { recursive: p[0] === 1 });
      }, describeAsPhrase);
    },
    [OP.RENAME]: (p) => {
      const no = writeRefused();
      if (no !== null) return no;
      const n = readI32le(p);
      const from = unstr(p.subarray(4, 4 + n));
      const to = unstr(p.subarray(4 + n));
      return changed(async () => {
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
      }, describeAsPhrase);
    },

    [OP.OPEN_INPUT]: async (p) => {
      const path = unstr(p);
      source = null;
      if (path === "") return CHANGED_OK;          // "standard input", which is empty here
      // `changed` rather than `readOrPhrase`: this answers a `Change` now, so a failure is a category
      // in the reply instead of an exception in the envelope — the same shape `OPEN_OUTPUT` uses, with
      // the same phrase policy for a browser's boilerplate messages (issue 0025).
      return await changed(async () => {
        source = { blob: await fileOf(path), at: 0 };
      }, describeAsPhrase);
    },
    [OP.READ_CHUNK]: async () => {
      const fed = source === null ? kids.readChunk() : null;
      if (fed !== null) return fed.length === 0 ? END : data(fed);
      // A spawned child's standard input is a queue its parent fills, which is the same shape a
      // fed child has and a different source: `pushChild` hands over a buffer, `send` arrives over
      // time. Both end, and the end is what `readChunk` has to be able to say.
      if (source === null && readChunkIn !== undefined) {
        const piped = await readChunkIn();
        return piped.length === 0 ? END : data(piped);
      }
      if (source === null) return END;
      try {
        const end = Math.min(source.at + CHUNK, source.blob.size);
        if (end <= source.at) return END;
        const slice = source.blob.slice(source.at, end);
        source.at = end;
        return data(new Uint8Array(await slice.arrayBuffer()));
      } catch (e) {
        return failed(e instanceof Error ? e.message : String(e));
      }
    },
    // Why the last read gave nothing — see `inputError` in platform.wac.
    [OP.OUTPUT_ERROR]: () => str(outputFailure),
    [OP.OPEN_OUTPUT]: async (p) => {
      const path = unstr(p);
      if (sink !== null) { await sink.close(); sink = null; }
      if (path === "") return CHANGED_OK;
      canWrite();
      return await changed(async () => {
        const { dir, name } = await resolve(path, true);
        sink = await (await dir.getFileHandle(name, { create: true })).createWritable();
      });
    },

    // No TCP in a page, and no honest approximation of one.
    [OP.CONNECT]: () => deny("network access"),
    [OP.LISTEN]: () => deny("network access"),
    [OP.ACCEPT]: () => deny("network access"),
    // Handle 0 is standard input everywhere else; a page has none, so it ends immediately
    // rather than refusing. Any other handle is a socket, which a page cannot have.
    // A page has no standard input and no sockets, so handle 0 is immediately at its end and
    // anything else is refused — as a `Read`, so a caller cannot read the refusal as "finished".
    [OP.RECV]: async (p) => {
      const h = readI32le(p);
      // Handle 0 is standard input, as everywhere: it exists so `waitAny` can watch it beside a
      // child. A page's own standard input is empty; a child's is what its parent sent.
      if (h === 0) {
        if (readChunkIn === undefined) return END;
        const piped = await readChunkIn();
        return piped.length === 0 ? END : data(piped);
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
      return failed("network access is not granted");
    },
    // A child's standard input. Sockets are a page's other missing capability, and asking for one
    // is still a denial — but a handle that names a child is not a socket, and the check has to come
    // first or a page could spawn a program it can never feed.
    [OP.SEND]: (p) => {
      const kid = children.get(readI32le(p));
      if (kid !== undefined) { kid.in.push(p.slice(4)); return EMPTY; }
      return deny("network access");
    },
    [OP.CLOSE_SOCKET]: (p) => {
      const h = readI32le(p);
      // Closing a child's handle ends its standard input *and* stops it. A program that wants only
      // the first should stop sending and wait for its output to end — that is `closeFeed`.
      const kid = children.get(h);
      if (kid !== undefined) {
        try { kid.in.end(); kid.kill(); } catch { /* already gone */ }
        children.delete(h);
      }
      return EMPTY;
    },
  };
}
