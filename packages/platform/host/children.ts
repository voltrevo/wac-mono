// Spawning a worker and talking to it as a handle.
//
// A child is not a new kind of thing. It is a handle, like a socket and like standard input,
// so `recv`, `send` and `waitAny` already work on it and the only new capability is `spawn`
// itself plus a way to ask for the exit code. That is deliberate: a shell wanting to run
// `a | b` reads one handle and writes another, and a relay wanting to watch a child *and* a
// socket at once is `waitAny` over two handles of different origin.
//
// The child gets its own bridge and its own capability world. Nothing is shared: the two
// `SharedArrayBuffer`s are separate, and `serveHostCalls` holds no global state, which is
// what makes one launcher thread able to serve several workers at once. Each child needs its
// *own* world instance rather than a shared handler table, because the worlds close over the
// current input, the current output and the socket map — one table between two children
// would hand one of them the other's socket.
//
// **What a child is granted, in this first cut: nothing but its standard input and output.**
// Its `write` and `log` arrive at the parent through the handle, its reads come from what
// the parent sends, and every other capability is denied. Passing a subset of the parent's
// grants through is the obvious next step and is not here yet — a child that could be handed
// the filesystem is a bigger decision than a child that can only speak.
//
// **The isolation is the language's, not the runtime's.** A wac child cannot reach past the
// capabilities it was handed because wac has no ambient anything. Arbitrary JavaScript in a
// spawned worker *can*: Deno workers inherit the process's permissions and dropping them
// needs `--unstable-worker-options`, which would put a non-capability flag in the shebang of
// every program that spawns. So `spawn` is a composition and concurrency primitive, not a
// confinement one, and the grants it takes are meaningful for wac children and advisory for
// anything else. See wac-mono issue 0015.

/**
 * How much may sit in a queue nobody is reading before a writer is told to stop.
 *
 * The same 8 MiB `child.ts` caps a *called* child's output at, and for the same reason: the program
 * deciding how much to produce is not the one holding it. `box yes` writes for ever by design.
 *
 * This became load-bearing when a shell started *spawning* its applets rather than calling them.
 * `yes | head -1` used to stop at the cap, because the in-process route had one; a spawned `yes`
 * wrote into an unbounded queue that nothing drained once `head` had finished, and a browser tab
 * died of it. A pipeline that ran its stages at once would end `yes` properly — `head` closing its
 * input is what stops it — and until then this is the backstop rather than the mechanism. Issue 0038.
 */
const QUEUE_CAP = 8 << 20;

/**
 * A queue of byte chunks with an end, read one chunk at a time.
 *
 * `cap` bounds what may sit unread. **Only an output queue gets one.** A child's *input* is bytes its
 * parent deliberately sent — `send` in `platform.wac` — and refusing those is data loss rather than
 * backpressure: the first version of this capped every queue, and under a loaded machine
 * `yes | head -1` came back empty, because 8 MiB was pushed into `head`'s input before `head` had
 * started reading and the overflow was dropped on the floor. Silently. A cap belongs where a
 * *producer* can be told to stop, which is the other direction.
 */
export class ByteQueue {
  #chunks: Uint8Array[] = [];
  #ended = false;
  #held = 0;
  #cap: number;
  #waiting: ((v: Uint8Array) => void) | null = null;

  constructor(cap = 0) {
    this.#cap = cap;
  }

  /**
   * Take these bytes, or answer false when the queue is full.
   *
   * False is the answer `write` in `platform.wac` already has a meaning for — "the other end is not
   * taking it" — and `box yes` is written as `while (cli.write(block)) {}` precisely so that it
   * stops. The host's job is to turn this into a failed `write`, which is what the caller does.
   */
  push(b: Uint8Array): boolean {
    if (this.#ended) return false;
    // Straight to a waiter if there is one, so nothing is buffered that is already wanted.
    if (this.#waiting !== null) {
      const w = this.#waiting;
      this.#waiting = null;
      w(b);
      return true;
    }
    if (this.#cap > 0 && this.#held + b.length > this.#cap) return false;
    this.#chunks.push(b);
    this.#held += b.length;
    return true;
  }

  /** No more will arrive. A reader waiting now gets the empty array that means "ended". */
  end(): void {
    this.#ended = true;
    if (this.#waiting !== null) {
      const w = this.#waiting;
      this.#waiting = null;
      w(new Uint8Array(0));
    }
  }

  /** The next chunk, or empty once ended and drained. */
  next(): Promise<Uint8Array> {
    const c = this.#chunks.shift();
    if (c !== undefined) this.#held -= c.length;
    if (c !== undefined) return Promise.resolve(c);
    if (this.#ended) return Promise.resolve(new Uint8Array(0));
    return new Promise((res) => {
      // One reader at a time. Two concurrent `recv`s on the same handle are a program bug
      // rather than something to arbitrate — the second would get bytes the first asked
      // for — so the earlier waiter is released empty instead of being lost.
      if (this.#waiting !== null) this.#waiting(new Uint8Array(0));
      this.#waiting = res;
    });
  }
}

/**
 * How long to wait for a bundle to say it loaded before assuming it did.
 *
 * Only ever paid by a bundle that sends no load notice — one built before `entry.ts` had one. A
 * current bundle answers in a millisecond, and this is not a limit on how long a *program* may
 * take: it is a limit on how long the parent waits to hear that the source is JavaScript.
 */
const LOAD_GRACE_MS = 500;

/** One spawned worker, from the parent's side. */
export type Child = {
  /** What the child wrote to standard output, in order. */
  out: ByteQueue;
  /**
   * What it wrote to standard error, in order — a stream of its own.
   *
   * Kept apart because a shell must be able to keep them apart: merged, `cat nosuch | wc -c` counts
   * the error message. `pushChild`/`popChild` have always answered with both, and a spawned child had
   * one stream until this existed.
   */
  err: ByteQueue;
  /** What the parent sent, which the child reads as its standard input. */
  in: ByteQueue;
  /** Resolves with the exit code, or a negative number if it failed to run. */
  exit: Promise<number>;
  /**
   * Whether the source loaded: the empty string when it did, the host's message when it did not.
   *
   * Awaited by `spawn` before it answers, which is the whole of the fix for wac-mono issue 0021.
   * A source that is not JavaScript throws while the worker is loading, and that error is *not*
   * contained by default — it propagated into the parent, which died with Deno's own message on
   * stderr and no chance to report it. `Child.error` existed for exactly this and stayed empty,
   * because the handle came back before the failure happened.
   *
   * There is nothing to wait for in the happy case beyond one message: `entry.ts` posts `ready`
   * as soon as the bundle evaluates, so a program that loads is answered immediately.
   */
  loaded: Promise<string>;
  /** Stop it. Safe to call more than once. */
  kill(): void;
};

/** Whatever the worker posts back. `ready` is the load notice; the rest matches `entry.ts`. */
type Result = { ok: true; code: number } | { ok: false; error: string } | { ready: true };

/**
 * The little of a worker this file needs, so that one implementation serves every host.
 *
 * A page and Deno both take a module from a blob URL; Node takes a source string with `eval` and
 * reports through an emitter rather than through handler properties. Those are three lines of
 * difference in how a worker is *made*, and everything after — the queues, the load notice, the
 * grace period, what a message means, when to stop the responder — is the same everywhere and was
 * worth having in one place rather than three.
 */
export type WorkerLike = {
  post(message: unknown): void;
  onMessage(f: (data: unknown) => void): void;
  /** A load or runtime error the parent must *contain*: see the note in `spawnChild`. */
  onError(f: (message: string) => void): void;
  terminate(): void;
};

/**
 * A worker from a module source, the way a page and Deno both do it.
 *
 * Exported because both hosts pass it and neither should have to write it. Node cannot use it —
 * there is no `Blob` URL to load a module from there — and passes its own.
 */
export function blobWorker(source: string): WorkerLike {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "module" });
  return {
    post: (m) => worker.postMessage(m),
    onMessage: (f) => { worker.onmessage = (e: MessageEvent) => f(e.data); },
    onError: (f) => {
      worker.onerror = (e: ErrorEvent) => {
        // **Contained here or not at all.** Without `preventDefault` the runtime re-raises a
        // worker's error as the *parent's* uncaught error and the parent dies — a shell handed a
        // file that is not a worker bundle exited 1 with the runtime's message and never got to
        // report a failed command. A handler that does not prevent the default is an observer.
        e.preventDefault();
        f(e.message === "" ? "the worker failed to load" : e.message);
      };
      worker.onmessageerror = (e: Event) => {
        e.preventDefault?.();
        f("the worker sent a message that could not be read");
      };
    },
    terminate: () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}

/**
 * Start a worker on `source` and wire its standard streams to queues.
 *
 * `startWorld` is supplied by the caller rather than imported, so this file needs no opinion about
 * which world a child gets: the Deno host passes its own, the browser host passes a page's, and
 * neither is visible from here. `makeWorker` is the other injection, and between them this function
 * is the whole of spawning for every host.
 */
export function spawnChild(
  source: string,
  args: string[],
  startWorld: (
    sab: SharedArrayBuffer,
    args: string[],
    out: ByteQueue,
    input: ByteQueue,
    err: ByteQueue,
  ) => { stop(): void },
  makeBridge: () => { sab: SharedArrayBuffer },
  makeWorker: (source: string) => WorkerLike = blobWorker,
): Child {
  // The two the child writes are capped; what the parent sends it is not — see `ByteQueue`.
  const out = new ByteQueue(QUEUE_CAP);
  const err = new ByteQueue(QUEUE_CAP);
  const input = new ByteQueue();
  const bridge = makeBridge();
  const responder = startWorld(bridge.sab, args, out, input, err);

  const worker = makeWorker(source);
  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    responder.stop();
    worker.terminate();
    // Whatever the child had written is already queued; this only says no more is coming.
    out.end();
    err.end();
  };

  // Resolved by whichever comes first: the load notice, a load error, or the child finishing
  // without ever saying either. The timer is the fallback for a bundle built before `ready`
  // existed — it must assume the child is *alive*, since a slow machine must not be reported as a
  // program that would not start. A failure after this window still arrives as a negative exit.
  let settleLoaded: (why: string) => void;
  const loaded = new Promise<string>((res) => { settleLoaded = res; });
  const assumeAlive = setTimeout(() => settleLoaded(""), LOAD_GRACE_MS);
  const done = (why: string) => {
    clearTimeout(assumeAlive);
    settleLoaded(why);
  };

  const exit = new Promise<number>((resolve) => {
    worker.onMessage((data) => {
      const r = data as Result;
      // The load notice, which says only that the bundle evaluated.
      if ("ready" in r) {
        done("");
        return;
      }
      done("");
      shutdown();
      resolve(r.ok ? r.code : -1);
    });
    worker.onError((message) => {
      done(message);
      shutdown();
      resolve(-1);
    });
  });

  // `child: true` so the worker runs `main` rather than `page`. A program with both is a page when a
  // person opened it and a program when something spawned it — a child has a handle, not a canvas,
  // and `packages/box`'s terminal exports both for exactly that reason.
  worker.post({ sab: bridge.sab, child: true });
  return { out, err, in: input, exit, loaded, kill: shutdown };
}

/**
 * The payload for a child that never started: -1, then the reason.
 *
 * The same shape a successful `spawn` answers with — a handle — so the worker side reads one i32
 * and whatever follows is the message. A negative handle is how `Child.error` comes to hold
 * something, and `packages/sh` already turns it into 126: "it exists and would not start",
 * distinct from the 127 of not existing.
 */
export function twoHandles(handle: number, errHandle: number, why: string): Uint8Array {
  const text = new TextEncoder().encode(why.split("\n")[0]);
  const out = new Uint8Array(8 + text.length);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, handle, true);
  dv.setInt32(4, errHandle, true);
  out.set(text, 8);
  return out;
}

export function failedChild(why: string): Uint8Array {
  // The first line only. A `SyntaxError` from a worker arrives with a code frame attached, which is
  // several lines and belongs on a terminal rather than inside `Child.error` — a shell puts this
  // after `sh: name: ` and expects one line, as every other diagnostic here is. The frame is not
  // lost: the worker's own isolate has already printed the whole of it to stderr, which is also why
  // a `preventDefault` in the parent cannot make that output go away.
  return twoHandles(-1, -1, why);
}

/**
 * The payload for a world that cannot spawn: -2, then why.
 *
 * Distinct from `failedChild`'s -1 on purpose. "There is no `spawn` here" is not a fact about the
 * program, so a caller that has another way to run it should use it — `packages/sh` falls through to
 * its own implementations, which is how the browser shell keeps sixty working applets even though a
 * page cannot spawn. Reporting 126 instead hid them behind a capability the world never had.
 */
export function noSpawnHere(why: string): Uint8Array {
  return twoHandles(-2, -2, why);
}

/** The grants a `spawn` or `spawnSelf` payload asks for: always the first four bytes. */
export function want(p: Uint8Array): number {
  return new DataView(p.buffer, p.byteOffset, p.byteLength).getInt32(0, true);
}

/**
 * A `spawn` payload: grants, then the source, then the arguments, then the child's directory.
 *
 * Here rather than in each host because it is the wire format, and three copies of a length-prefixed
 * walk is three chances to disagree about it. `provider.ts` writes it; this reads it.
 */
export function unpackSpawn(p: Uint8Array): { source: string; args: string[]; cwd: string } {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const dec = new TextDecoder();
  const sourceLen = dv.getInt32(4, true);
  const source = dec.decode(p.subarray(8, 8 + sourceLen));
  const argsAt = 8 + sourceLen;
  const argsLen = dv.getInt32(argsAt, true);
  const joined = dec.decode(p.subarray(argsAt + 4, argsAt + 4 + argsLen));
  return {
    source,
    args: joined.length === 0 ? [] : joined.split("\u0000"),
    cwd: dec.decode(p.subarray(argsAt + 4 + argsLen)),
  };
}

/** The same, for `spawnSelf`, which needs no source: grants, arguments, directory. */
export function unpackSpawnSelf(p: Uint8Array): { args: string[]; cwd: string } {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const dec = new TextDecoder();
  const argsLen = dv.getInt32(4, true);
  const joined = dec.decode(p.subarray(8, 8 + argsLen));
  return {
    args: joined.length === 0 ? [] : joined.split("\u0000"),
    cwd: dec.decode(p.subarray(8 + argsLen)),
  };
}
