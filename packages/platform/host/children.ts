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

/** One spawned worker, from the parent's side. */
export type Child = {
  /** What the child wrote, in order. */
  out: ByteQueue;
  /** What the parent sent, which the child reads as its standard input. */
  in: ByteQueue;
  /** Resolves with the exit code, or a negative number if it failed to run. */
  exit: Promise<number>;
  /** Stop it. Safe to call more than once. */
  kill(): void;
};

/** Whatever the worker posts back when it finishes. Matches `entry.ts`'s `Result`. */
type Result = { ok: true; code: number } | { ok: false; error: string };

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

  const exit = new Promise<number>((resolve) => {
    worker.onmessage = (e: MessageEvent) => {
      const r = e.data as Result;
      shutdown();
      resolve(r.ok ? r.code : -1);
    };
    worker.onerror = () => {
      shutdown();
      resolve(-1);
    };
  });

  worker.postMessage({ sab: bridge.sab });
  return { out, in: input, exit, kill: shutdown };
}
