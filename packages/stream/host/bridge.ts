// A wac pull-loop as a `TransformStream`.
//
// The point of the exercise: wac cannot suspend, so a streaming transform normally has to be
// written as a resumable state machine. It does not have to be, if the *host* provides the
// blocking. The transform runs on a worker where `Atomics.wait` is allowed, so its `read()` simply
// waits, and the transform stays an ordinary nested loop.
//
// What that buys, concretely: `packages/stream/src/transform.wac` is a `while` loop. The version
// that resumes mid-unit without this would carry its position, its held bytes and its phase as
// saved fields, and would have to be re-entered correctly from each of them.
//
// Requires `SharedArrayBuffer`, which Deno gives without ceremony and a browser gives only under
// cross-origin isolation. Where it is unavailable, `runWhole` below does the same work in one
// call — correct, but O(input) memory and no incremental output.

import {
  IN_EOF,
  IN_ERR,
  IN_HEAD,
  IN_SEQ,
  IN_TAIL,
  OUT_DONE,
  OUT_HEAD,
  OUT_SEQ,
  OUT_TAIL,
  rings,
  ringRead,
  ringWrite,
  signal,
  STATUS,
  STATUS_RUNNING,
  STATUS_THREW,
  TOTAL_BYTES,
  CAP,
} from "./layout.ts";

export type TransformOptions = {
  /** Path to the `.wac` entry, relative to the repo root. */
  modulePath: string;
  /** An export of the shape `i32 f(fn[u8[]()] read, fn[bool(u8[])] write)`. */
  entry: string;
};

export class TransformFailed extends Error {
  constructor(readonly status: number) {
    super(
      status === STATUS_THREW
        ? "the wac transform trapped"
        : `the wac transform reported ${status}`,
    );
    this.name = "TransformFailed";
  }
}

/** Wait for `ctrl[slot]` to move away from `expected`, without blocking the main thread. */
async function waitAsync(ctrl: Int32Array, slot: number, expected: number): Promise<void> {
  const r = Atomics.waitAsync(ctrl, slot, expected);
  if (r.async) await r.value;
}

/** The two ends of a running transform. Structurally a `TransformStream`, so `pipeThrough` takes it. */
export type WacStream = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

/**
 * Run `entry` from `modulePath` as a stream.
 *
 * Built from a `ReadableStream` and a `WritableStream` rather than a `TransformStream` because
 * back-pressure has to run in both directions and only this shape gives both. A transformer is
 * driven entirely by its *writer*: its `transform` is the sole chance to emit, so output can only
 * appear when input is pushed in, and a consumer that stops reading is never noticed. Here the
 * readable's `pull` is the consumer asking, so:
 *
 *   - **the writer waits** when the input ring is full, because the transform has not caught up;
 *   - **the transform blocks** when the output ring is full, because the consumer has not read.
 *
 * Neither side polls. The transform is a plain wac loop that knows about none of it.
 */
export function wacTransformStream(options: TransformOptions): WacStream {
  const sab = new SharedArrayBuffer(TOTAL_BYTES);
  const { ctrl, inBytes, outBytes } = rings(sab);
  Atomics.store(ctrl, STATUS, STATUS_RUNNING);

  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.postMessage({ sab, modulePath: options.modulePath, entry: options.entry });

  /** Copy `chunk` into the input ring, waiting for room. */
  async function feed(chunk: Uint8Array): Promise<void> {
    let at = 0;
    while (at < chunk.length) {
      const head = Atomics.load(ctrl, IN_HEAD);
      const tail = Atomics.load(ctrl, IN_TAIL);
      const free = CAP - (head - tail);
      if (free === 0) {
        await waitAsync(ctrl, IN_TAIL, tail);
        continue;
      }
      const n = Math.min(free, chunk.length - at);
      ringWrite(inBytes, head, chunk.subarray(at, at + n));
      Atomics.store(ctrl, IN_HEAD, head + n);
      signal(ctrl, IN_SEQ);
      at += n;
    }
  }

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return feed(chunk);
    },
    close() {
      Atomics.store(ctrl, IN_EOF, 1);
      signal(ctrl, IN_SEQ);                   // wake a transform waiting for input that will not come
    },
    abort() {
      // A writable is aborted when whatever was feeding it failed, which is exactly the case the
      // transform could not previously distinguish from a clean close. Say so, wake it, and let it
      // return a nonzero status of its own accord — terminating the worker outright would lose both
      // the status and any output already produced.
      Atomics.store(ctrl, IN_ERR, 1);
      Atomics.store(ctrl, IN_EOF, 1);
      signal(ctrl, IN_SEQ);
    },
  });

  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Called when the consumer has room, so enqueueing here is what makes reading the
      // back-pressure signal: until this runs, the output ring fills and the transform blocks in it.
      while (true) {
        const seq = Atomics.load(ctrl, OUT_SEQ);   // before the checks, so no event can be missed
        const head = Atomics.load(ctrl, OUT_HEAD);
        const tail = Atomics.load(ctrl, OUT_TAIL);
        if (head > tail) {
          controller.enqueue(ringRead(outBytes, tail, head - tail));
          Atomics.store(ctrl, OUT_TAIL, head);
          Atomics.notify(ctrl, OUT_TAIL);          // the transform may be waiting for room
          return;
        }
        if (Atomics.load(ctrl, OUT_DONE) === 1) {
          worker.terminate();
          const status = Atomics.load(ctrl, STATUS);
          if (status < 0) controller.error(new TransformFailed(status));
          else controller.close();
          return;
        }
        await waitAsync(ctrl, OUT_SEQ, seq);
      }
    },
    cancel() {
      worker.terminate();
    },
  });

  return { readable, writable };
}

/**
 * The same transform over a whole input, with no worker and no `SharedArrayBuffer`.
 *
 * The fallback for anywhere the bridge cannot run, and the oracle the streaming tests compare
 * against — if the two ever disagree, the chunking is what changed, since the wac code is
 * identical.
 */
// The callbacks are hoisted out of `runWhole` and given mutable state instead of closing over it,
// which looks like the wrong trade until you know what bindgen does: it registers each distinct
// function *identity* in a fixed 16-slot table per signature, and never releases a slot. A fresh
// closure per call therefore fails on the seventeenth call with a `RangeError`, module-wide and
// permanently. Two stable identities can be reused for ever.
//
// Safe because the transform runs to completion synchronously before `runWhole` returns, so there
// is never a second job in flight.
let job: {
  input: Uint8Array;
  given: boolean;
  parts: Uint8Array[];
  Read: { Data(b: Uint8Array): unknown; End(): unknown };
} | null = null;

function readWhole(): unknown {
  if (job === null) return null;
  if (job.given) return job.Read.End();
  job.given = true;
  return job.Read.Data(job.input);
}

function writeWhole(b: Uint8Array): boolean {
  job?.parts.push(b.slice());
  return true;
}

export async function runWhole(options: TransformOptions, input: Uint8Array): Promise<Uint8Array> {
  const { wacBind } = await import("../../../harness/wacBind.ts");
  const mod = await wacBind(options.modulePath) as unknown as Record<string, unknown>;
  const transform = mod[options.entry] as (
    read: () => unknown,
    write: (b: Uint8Array) => boolean,
  ) => number;

  // The variant constructors come from the module being driven, since a wac enum crosses as a class
  // with one static per variant — and a source on this side must now say which state it means.
  job = {
    input,
    given: false,
    parts: [],
    Read: mod.Read as { Data(b: Uint8Array): unknown; End(): unknown },
  };
  const status = transform(readWhole, writeWhole);
  const parts = job.parts;
  job = null;
  if (status < 0) throw new TransformFailed(status);

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
