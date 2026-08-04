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

/** A queue of byte chunks with an end, read one chunk at a time. */
export class ByteQueue {
  #chunks: Uint8Array[] = [];
  #ended = false;
  #waiting: ((v: Uint8Array) => void) | null = null;

  push(b: Uint8Array): void {
    if (this.#ended) return;
    // Straight to a waiter if there is one, so nothing is buffered that is already wanted.
    if (this.#waiting !== null) {
      const w = this.#waiting;
      this.#waiting = null;
      w(b);
      return;
    }
    this.#chunks.push(b);
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
  /** What the child wrote, in order. */
  out: ByteQueue;
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
 * Start a worker on `source` and wire its standard streams to queues.
 *
 * `startWorld` is supplied by the caller rather than imported, so this file needs no opinion
 * about which world a child gets — the Deno world passes its own, and Node's could pass
 * theirs. It receives the queues and must return a `stop()` for the responder it starts.
 */
export function spawnChild(
  source: string,
  args: string[],
  startWorld: (
    sab: SharedArrayBuffer,
    args: string[],
    out: ByteQueue,
    input: ByteQueue,
  ) => { stop(): void },
  makeBridge: () => { sab: SharedArrayBuffer },
): Child {
  const out = new ByteQueue();
  const input = new ByteQueue();
  const bridge = makeBridge();
  const responder = startWorld(bridge.sab, args, out, input);

  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "module" });
  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    responder.stop();
    worker.terminate();
    URL.revokeObjectURL(url);
    // Whatever the child had written is already queued; this only says no more is coming.
    out.end();
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
    worker.onmessage = (e: MessageEvent) => {
      const r = e.data as Result;
      if ("ready" in r) {
        done("");
        return;
      }
      done("");
      shutdown();
      resolve(r.ok ? r.code : -1);
    };
    worker.onerror = (e: ErrorEvent) => {
      // **This is the fix.** Without `preventDefault` the error is re-raised as the *parent's*
      // uncaught error and the parent dies: a shell handed a file that is not a worker bundle
      // exited 1 with Deno's message, rather than reporting a command that could not be executed.
      // A handler that does not prevent the default is an observer, not a handler.
      e.preventDefault();
      done(e.message === "" ? "the worker failed to load" : e.message);
      shutdown();
      resolve(-1);
    };
    // A message that cannot be deserialised is the same kind of failure and would escape the same
    // way. Nothing here posts anything but plain objects, so this is a guard rather than a case.
    worker.onmessageerror = (e: Event) => {
      e.preventDefault?.();
      done("the worker sent a message that could not be read");
      shutdown();
      resolve(-1);
    };
  });

  worker.postMessage({ sab: bridge.sab });
  return { out, in: input, exit, loaded, kill: shutdown };
}

/**
 * The payload for a child that never started: -1, then the reason.
 *
 * The same shape a successful `spawn` answers with — a handle — so the worker side reads one i32
 * and whatever follows is the message. A negative handle is how `Child.error` comes to hold
 * something, and `packages/sh` already turns it into 126: "it exists and would not start",
 * distinct from the 127 of not existing.
 */
export function failedChild(why: string): Uint8Array {
  // The first line only. A `SyntaxError` from a worker arrives with a code frame attached, which is
  // several lines and belongs on a terminal rather than inside `Child.error` — a shell puts this
  // after `sh: name: ` and expects one line, as every other diagnostic here is. The frame is not
  // lost: the worker's own isolate has already printed the whole of it to stderr, which is also why
  // a `preventDefault` in the parent cannot make that output go away.
  const text = new TextEncoder().encode(why.split("\n")[0]);
  const out = new Uint8Array(4 + text.length);
  new DataView(out.buffer).setInt32(0, -1, true);
  out.set(text, 4);
  return out;
}
