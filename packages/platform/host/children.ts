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

import { CHUNK } from "./layout.ts";

/** One array from several, for a reader that asked for more than one chunk's worth. */
function join(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

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
  /** Writers parked because the queue is full, with the bytes they are trying to send. */
  #roomWanted: { bytes: Uint8Array; res: (ok: boolean) => void }[] = [];

  constructor(cap = 0) {
    this.#cap = cap;
  }

  /**
   * Take these bytes, waiting for room if the queue is full, and answering false once it has ended.
   *
   * **Full and gone are different answers**, and conflating them truncated a file silently. `write` in
   * `platform.wac` answers false for "the other end is not taking it", and a producer is written to
   * stop on that — `box yes` is `while (cli.write(b)) {}`. So refusing a write because the reader is
   * merely *behind* tells the producer to stop when it should have waited: `seq 1 2000000000 > out`
   * wrote 276 MB, exited 0, and left a file two per cent of the size bash writes. Nothing said so.
   *
   * A real pipe blocks a writer whose reader is behind and fails one whose reader has gone. This does
   * the same: the promise resolves when `take` makes room, and `end` resolves the waiters false. The
   * child is parked in `Atomics.wait` on its own `write` call meanwhile, which is exactly the shape a
   * blocking write has on the other side of a bridge.
   */
  push(b: Uint8Array): Promise<boolean> {
    if (this.#ended) return Promise.resolve(false);
    // Straight to a waiter if there is one, so nothing is buffered that is already wanted.
    if (this.#waiting !== null) {
      const w = this.#waiting;
      this.#waiting = null;
      w(b);
      return Promise.resolve(true);
    }
    if (this.#cap > 0 && this.#held + b.length > this.#cap) {
      return new Promise<boolean>((res) => { this.#roomWanted.push({ bytes: b, res }); });
    }
    this.#chunks.push(b);
    this.#held += b.length;
    return Promise.resolve(true);
  }

  /**
   * Hand queued bytes to the writers waiting for room, in the order they arrived.
   *
   * Called from `take`, which is the only thing that makes room. In arrival order because a stream is
   * ordered: releasing the smallest first would interleave one producer's output with another's.
   */
  private releaseRoom(): void {
    while (this.#roomWanted.length > 0) {
      const first = this.#roomWanted[0];
      if (this.#cap > 0 && this.#held + first.bytes.length > this.#cap) return;
      this.#roomWanted.shift();
      this.#chunks.push(first.bytes);
      this.#held += first.bytes.length;
      first.res(true);
    }
  }

  /**
   * Everything, to the end — for `readStdin`, which promises exactly that.
   *
   * A child's standard input arrives over time, so "all of it" means waiting for the end rather than
   * taking what is there. Serving `readStdin` with one chunk is the bug this exists to fix:
   * `seq 1 5 | sort -r` printed `1`, because `sort` read to the end before sorting and the end came
   * after one line. Nothing showed it earlier — a sequential pipeline sent the whole input in one
   * `send`, so one chunk *was* everything.
   */
  async rest(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (;;) {
      const c = await this.next();
      if (c.length === 0) return join(parts);
      parts.push(c);
    }
  }

  /** Up to `limit` bytes of what is queued, or null when nothing is. */
  private take(limit: number): Uint8Array | null {
    if (this.#chunks.length === 0) return null;
    if (this.#chunks.length === 1 && this.#chunks[0].length <= limit) {
      const only = this.#chunks.shift()!;
      this.#held -= only.length;
      this.releaseRoom();
      return only;
    }
    const parts: Uint8Array[] = [];
    let taken = 0;
    while (this.#chunks.length > 0 && taken < limit) {
      const head = this.#chunks[0];
      if (taken + head.length <= limit) {
        this.#chunks.shift();
        parts.push(head);
        taken += head.length;
      } else {
        // Split it: the rest stays at the front, so nothing is reordered and nothing is lost.
        const room = limit - taken;
        parts.push(head.subarray(0, room));
        this.#chunks[0] = head.subarray(room);
        taken += room;
      }
    }
    this.#held -= taken;
    this.releaseRoom();
    return join(parts);
  }

  /**
   * No more will arrive. A reader waiting now gets the empty array that means "ended", and a *writer*
   * waiting for room is refused — which is how a producer learns its reader has gone rather than is
   * merely slow. `head -1` stopping `seq` is this path: the shell stops the stage, which ends the
   * queue, which fails the write the producer is parked on.
   */
  end(): void {
    this.#ended = true;
    if (this.#waiting !== null) {
      const w = this.#waiting;
      this.#waiting = null;
      w(new Uint8Array(0));
    }
    while (this.#roomWanted.length > 0) {
      this.#roomWanted.shift()!.res(false);
    }
  }

  /**
   * One last thing, then the end — for a diagnostic about the stream itself.
   *
   * Two reasons this is not `push` followed by `end`. A full queue *parks* a writer, and `end`
   * refuses the parked ones, so a last line pushed onto a full queue would be dropped by the very
   * call meant to follow it. And a diagnostic is bounded — one line, written by the host — so the
   * cap it bypasses is not protecting anything from it. The cap exists to keep an unread producer
   * from holding megabytes; this is the note explaining why nothing more is coming.
   */
  endWith(b: Uint8Array): void {
    if (!this.#ended) {
      if (this.#waiting !== null) {
        const w = this.#waiting;
        this.#waiting = null;
        w(b);
      } else {
        this.#chunks.push(b);
        this.#held += b.length;
      }
    }
    this.end();
  }

  /**
   * The next chunk, or empty once ended and drained.
   *
   * **Everything queued, up to `CHUNK`** — not literally the next thing pushed. A writer that emits a
   * line at a time and a reader on the other side of a bridge is one round trip per line otherwise:
   * `seq 1 200000 | wc -l` took forty-five seconds that way, almost all of it in two hundred thousand
   * parks and wakes. Coalescing is free here and legal by the protocol, which promises *at most*
   * `CHUNK` bytes and says a short read means nothing.
   */
  next(): Promise<Uint8Array> {
    const c = this.take(CHUNK);
    if (c !== null) return Promise.resolve(c);
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
/**
 * The first line of every `--worker` bundle, and the reason a spawn can refuse one that is not.
 *
 * A file that *parses* but is not a worker bundle used to wedge the caller for ever: it evaluated, it
 * never spoke the bridge protocol, and nothing distinguished it from a program still loading. That was
 * wac-mono 0033, and its hard part was that no timer answers the question — a deadline long enough to
 * be safe on a loaded machine is long enough to be a hang, and one short enough to be useful reports a
 * slow load as a program that would not start.
 *
 * A marker answers it before anything runs. `build.ts` writes this line at the top of what `--worker`
 * emits; `spawnChild` looks for it in the source it was handed and fails immediately when it is absent,
 * with a message that says which of the two things went wrong. The version is in it so that a bundle
 * built by an older compiler can be told from a file that was never one at all.
 */
export const WORKER_MARKER = "//wac-worker 1";

/**
 * How long a bundle that *is* one has to say `ready`.
 *
 * Fatal rather than assumed-alive: the operator's call on 0033 was that `ready` is a required part of
 * the protocol. The marker above means the only thing this can still catch is a bundle that carries the
 * marker and never speaks — which is malformed, not slow.
 *
 * **It was five seconds, and five seconds turned out to be a guess about the machine.** Evaluation is
 * tens of milliseconds when a core is free, so five seconds looked like two orders of magnitude of
 * headroom; then every command in the shell became a spawned worker, a suite running eight scripts at a
 * time met a machine at load 14, and one `printf` in 722 differential scripts missed the deadline. The
 * cost of waiting longer is paid only by a bundle that is already broken, and the cost of waiting less
 * is a red suite that says "does not speak the bridge protocol" about a program that speaks it fine.
 * So: generous by two more orders of magnitude, and overridable for the one test that has to wait it
 * out.
 */
const LOAD_GRACE_MS = 30_000;

/**
 * The grace, in milliseconds, or the default.
 *
 * A parameter rather than a constant read from the environment here, because this file also runs in a
 * page: which knob a host offers is the host's business. `deno.ts` and `node.ts` read
 * `WAC_LOAD_GRACE_MS`, which is how `spawn.test.ts` waits one second for the deadline instead of thirty.
 */
export function graceOf(ms: number | undefined): number {
  return ms === undefined || !Number.isFinite(ms) || ms <= 0 ? LOAD_GRACE_MS : ms;
}

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
  args: Uint8Array[],
  startWorld: (
    sab: SharedArrayBuffer,
    args: Uint8Array[],
    out: ByteQueue,
    input: ByteQueue,
    err: ByteQueue,
  ) => { stop(): void },
  makeBridge: () => { sab: SharedArrayBuffer },
  makeWorker: (source: string) => WorkerLike = blobWorker,
  graceMs?: number,
): Child {
  // The two the child writes are capped; what the parent sends it is not — see `ByteQueue`.
  const out = new ByteQueue(QUEUE_CAP);
  const err = new ByteQueue(QUEUE_CAP);
  const input = new ByteQueue();

  // **Before anything starts.** A file that parses and is not one of these used to be indistinguishable
  // from a program still loading, and the caller waited for ever (0033). The marker is a fact about the
  // source, so it is answered here rather than by a deadline — and the message says which of the two
  // things it is, because "not a wac worker bundle" and "built by an older wac" are different problems
  // with different fixes.
  if (!source.startsWith(WORKER_MARKER)) {
    const looksBuilt = source.includes("SharedArrayBuffer") || source.includes("wacBind");
    out.end();
    err.end();
    input.end();
    return {
      out,
      err,
      in: input,
      exit: Promise.resolve(-1),
      loaded: Promise.resolve(
        looksBuilt
          ? "built by an older wac than this one: rebuild it with --worker"
          : "not a wac worker bundle: build one with --worker",
      ),
      kill: () => {},
    };
  }

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

  // Resolved by whichever comes first: the load notice, a load error, or the child finishing without
  // ever saying either. The timer used to assume the child was *alive*, which is what let a bundle that
  // never speaks the protocol wedge the caller for ever (0033). `ready` is required now, so the timer
  // is a failure — and the marker checked above is what makes that safe, since the case a timer cannot
  // judge is caught before the worker starts.
  let settleLoaded: (why: string) => void;
  const loaded = new Promise<string>((res) => { settleLoaded = res; });
  const grace = graceOf(graceMs);
  const assumeAlive = setTimeout(
    () => settleLoaded(
      "did not report ready within " + grace + "ms: a worker bundle that does not speak the " +
        "bridge protocol, or a machine too loaded to have evaluated it",
    ),
    grace,
  );
  const done = (why: string) => {
    clearTimeout(assumeAlive);
    settleLoaded(why);
  };

  // Whether the child ever got as far as running. Which of two places the reason for a failure
  // belongs depends on it: before `ready` the caller is still holding `loaded` and reports the
  // message itself, and after `ready` nobody is listening for one.
  let started = false;

  const exit = new Promise<number>((resolve) => {
    worker.onMessage((data) => {
      const r = data as Result;
      // The load notice, which says only that the bundle evaluated.
      if ("ready" in r) {
        done("");
        started = true;
        return;
      }
      done("");
      started = true;
      // **A trap the child caught about itself.** `entry.ts` wraps `main` and posts
      // `{ok: false, error}` for anything thrown out of it, and that error used to be dropped right
      // here — the parent got -1 and no reason, which is how `seq 1 200000000 | wc -c` came to print
      // nothing and exit 126 where bash prints 1888888898. Same channel as the runtime failure
      // below, for the same reason: standard error is where a program's diagnostics go, and the
      // label says the runtime is speaking rather than the program.
      if (!r.ok) {
        err.endWith(new TextEncoder().encode("wac: " + r.error.split("\n")[0] + "\n"));
      }
      shutdown();
      resolve(r.ok ? r.code : -1);
    });
    worker.onError((message) => {
      done(message);
      // **A child that dies after it started used to die in silence.** `loaded` has already been
      // settled and read by then, so the reason went nowhere: the parent saw exit -1, which
      // `packages/sh` reports as 126 — "it exists and would not start" — with no message anywhere,
      // and 126 is not even true of a program that started and then stopped. `seq 1 200000000 | wc -c`
      // is the case that showed it: bash prints 1888888898, and this printed nothing at all and
      // exited 126, because `wc` reads all of its input and 1.9 GB of it does not fit in one array.
      //
      // So the reason goes onto the child's standard error, which is the stream a program's
      // diagnostics travel on and the one a shell already relays. It is *not* the program's own
      // output, so it is labelled with what is speaking — the runtime the child was running in,
      // which is the only thing that saw the failure.
      if (started) {
        err.endWith(new TextEncoder().encode("wac: " + message.split("\n")[0] + "\n"));
      }
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
export function unpackSpawn(
  p: Uint8Array,
): { source: string; args: Uint8Array[]; cwd: string; inheritIn: boolean } {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const dec = new TextDecoder();
  const sourceLen = dv.getInt32(4, true);
  const source = dec.decode(p.subarray(8, 8 + sourceLen));
  const argsAt = 8 + sourceLen;
  const after = unpackArgs(p, argsAt);
  const cwdLen = dv.getInt32(after.at, true);
  return {
    source,
    args: after.args,
    cwd: dec.decode(p.subarray(after.at + 4, after.at + 4 + cwdLen)),
    inheritIn: p[after.at + 4 + cwdLen] === 1,
  };
}

/** The same, for `spawnSelf`, which needs no source: grants, arguments, directory. */
export function unpackSpawnSelf(
  p: Uint8Array,
): { args: Uint8Array[]; cwd: string; inheritIn: boolean } {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const dec = new TextDecoder();
  const after = unpackArgs(p, 4);
  const cwdLen = dv.getInt32(after.at, true);
  return {
    args: after.args,
    cwd: dec.decode(p.subarray(after.at + 4, after.at + 4 + cwdLen)),
    inheritIn: p[after.at + 4 + cwdLen] === 1,
  };
}

/**
 * The argument vector: a count, then each argument length-prefixed.
 *
 * **Bytes, and one length each.** This used to be one blob of text with NUL separators, decoded here with
 * a `TextDecoder` — which replaced anything that was not valid UTF-8, so an argument arrived at the child
 * as replacement characters and a program using it as a path opened the wrong file. An argument is bytes
 * on every system this targets, so the wire format carries bytes and the capability's type says so.
 * wac-mono 0065.
 *
 * Lengths rather than a separator because that is the honest encoding once the payload is bytes: a NUL
 * cannot appear in an argument on the systems being imitated, but relying on that is a rule the *format*
 * does not have to depend on.
 */
function unpackArgs(p: Uint8Array, at: number): { args: Uint8Array[]; at: number } {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const count = dv.getInt32(at, true);
  let cursor = at + 4;
  const args: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const len = dv.getInt32(cursor, true);
    args.push(p.slice(cursor + 4, cursor + 4 + len));
    cursor += 4 + len;
  }
  return { args, at: cursor };
}
