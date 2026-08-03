// Worker side: turn a bridge into the capability structs a wac application receives.
//
// Every closure here is created **once per application**, never per call. bindgen
// registers each distinct function identity in a fixed table of sixteen per signature and
// never frees a slot, so a fresh closure per call dies on the seventeenth with a
// `RangeError` a long way from its cause. `packages/stream` hit this and its README says
// the same thing: hold stable functions and put the varying part in their arguments.
//
// That rule is why a ticket carries an `i32` and three *shared* resolvers rather than a
// closure over its own answer. Every `readFile` in a program hands back the same three
// functions with a different number in front of them.
//
// A ticket's number is its slot and its generation packed together, so nothing has to be
// kept in a table here and a ticket dropped on the floor leaks nothing on this side. Four
// slots is two bits; the generation takes the rest.

import { type Bridge, SLOTS } from "./layout.ts";
import {
  cancel,
  collect,
  hostCall,
  HostCallError,
  i32le,
  isDone,
  waitAny,
  readI32le,
  readI64le,
  str,
  submit,
  type Ticket,
  unstr,
} from "./call.ts";
import { OP } from "./ops.ts";

const EMPTY = new Uint8Array(0);
const SLOT_BITS = Math.ceil(Math.log2(SLOTS));
const SLOT_MASK = (1 << SLOT_BITS) - 1;

const pack = (t: Ticket): number => t.slot | (t.gen << SLOT_BITS);
const unpack = (id: number): Ticket => ({ slot: id & SLOT_MASK, gen: id >>> SLOT_BITS });

/** The generated classes this needs from a module that imports `platform.wac`. */
export type PlatformClasses = {
  Core: { of(...caps: unknown[]): unknown };
  Cli: { of(...caps: unknown[]): unknown };
  FileResult: { of?(...a: unknown[]): unknown };
};

/** One monomorphised `Pending<T>`. bindgen names them `Pending_FileResult` and so on. */
type PendingClass = { of(id: number, resolve: unknown, settled: unknown, drop: unknown): unknown };

/** Every `Pending<T>` the world hands out. */
export type PendingClasses = {
  Pending_i32: PendingClass;
  Pending_i64: PendingClass;
  Pending_string: PendingClass;
  Pending_stringOpt: PendingClass;
  Pending_u8Arr: PendingClass;
  Pending_bool: PendingClass;
  Pending_stringArrOpt: PendingClass;
  Pending_FileResult: PendingClass;
  Pending_Stat: PendingClass;
  Pending_Socket: PendingClass;
  Pending_Child: PendingClass;
};

/**
 * `Core`, built from the bridge.
 *
 * `log` and `warn` hand back nothing. A ticket for a line of output would be noise at
 * every call site for a capability no program will overlap, and the world keeps writes to
 * one destination in order anyway, so a caller loses nothing by not being able to wait.
 */
export function coreOf(
  b: Bridge,
  cls: { Core: PlatformClasses["Core"] } & PendingClasses,
): unknown {
  const settled = (id: number) => isDone(b, unpack(id));
  const drop = (id: number) => { cancel(b, unpack(id)); };
  const i64 = (id: number) => readI64le(collect(b, unpack(id)));
  const bytes = (id: number) => collect(b, unpack(id));

  const asI64 = (t: Ticket) => cls.Pending_i64.of(pack(t), i64, settled, drop);
  const asBytes = (t: Ticket) => cls.Pending_u8Arr.of(pack(t), bytes, settled, drop);

  return cls.Core.of(
    /*= nowMillis */
    () => asI64(submit(b, OP.NOW_MILLIS, EMPTY)),
    /*= monotonicNanos */
    () => asI64(submit(b, OP.MONOTONIC_NANOS, EMPTY)),
    /*= sleepMillis */
    (ms: number) => asI64(submit(b, OP.SLEEP_MILLIS, i32le(ms))),
    /*= randomBytes */
    (n: number) => asBytes(submit(b, OP.RANDOM_BYTES, i32le(n))),
    /*= log */
    // Submitted *and collected*. A bare submit claims a slot the worker never gives
    // back, so four log lines exhausted the ring and the fifth call parked forever —
    // which showed up as `ls .` failing while `ls somefile` worked, because only the
    // former reached a log loop.
    (line: string) => { hostCall(b, OP.LOG, str(line)); },
    /*= warn */
    (line: string) => { hostCall(b, OP.WARN, str(line)); });
}

/**
 * `Cli`, built from the bridge.
 *
 * `readFile` answers with a `FileResult` rather than a nullable array so a failure can
 * carry its reason — the wac side gets `ok`, the bytes, and the host's message.
 */
export function cliOf(
  b: Bridge,
  cls: {
    Cli: PlatformClasses["Cli"];
    FileResult: { of(...a: unknown[]): unknown };
    Stat: { of(...a: unknown[]): unknown };
    Socket: { of(...a: unknown[]): unknown };
    Child: { of(...a: unknown[]): unknown };
  } & PendingClasses,
): unknown {
  const settled = (id: number) => isDone(b, unpack(id));
  const drop = (id: number) => { cancel(b, unpack(id)); };

  // One resolver per return shape, hoisted for the reason in the file header.
  const bytes = (id: number) => collect(b, unpack(id));
  const i32 = (id: number) => readI32le(collect(b, unpack(id)));
  const text = (id: number) => unstr(collect(b, unpack(id)));
  /** Empty means it worked; anything else is the host's message. */
  const outcome = (id: number) => {
    try {
      collect(b, unpack(id));
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  /** True when it worked. A failure is an answer here, not an exception. */
  const ok = (id: number) => {
    try {
      collect(b, unpack(id));
      return true;
    } catch {
      return false;
    }
  };
  /** Bytes, or empty where a broken source is indistinguishable from an ended one. */
  const chunk = (id: number) => {
    try {
      return collect(b, unpack(id));
    } catch {
      return EMPTY;
    }
  };
  const fileResult = (id: number) => {
    try {
      return cls.FileResult.of(true, collect(b, unpack(id)), "");
    } catch (e) {
      return cls.FileResult.of(false, EMPTY, e instanceof Error ? e.message : String(e));
    }
  };
  const stat = (id: number) => {
    try {
      const out = collect(b, unpack(id));
      // exists, isFile, isDir as bytes, then size and mtime as little-endian i64s.
      const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
      return cls.Stat.of(
        out[0] === 1, out[1] === 1, out[2] === 1,
        dv.getBigInt64(3, true), dv.getBigInt64(11, true),
      );
    } catch {
      return cls.Stat.of(false, false, false, 0n, 0n);
    }
  };
  const dirNames = (id: number) => {
    try {
      const out = collect(b, unpack(id));
      if (out.length === 0) return [];
      // NUL-separated: a filename may contain anything but a NUL or a slash.
      return unstr(out).split("\u0000");
    } catch {
      return null;
    }
  };
  const maybeText = (id: number) => {
    const out = collect(b, unpack(id));
    // One byte of presence in front, because an unset variable and an empty one are
    // different and a bare empty payload cannot say which this is.
    return out[0] === 1 ? unstr(out.subarray(1)) : null;
  };
  const child = (id: number) => {
    try {
      return cls.Child.of(readI32le(collect(b, unpack(id))), "");
    } catch (e) {
      return cls.Child.of(-1, e instanceof Error ? e.message : String(e));
    }
  };
  const socket = (id: number) => {
    try {
      return cls.Socket.of(readI32le(collect(b, unpack(id))), "");
    } catch (e) {
      return cls.Socket.of(-1, e instanceof Error ? e.message : String(e));
    }
  };

  const T = {
    i32: (t: Ticket) => cls.Pending_i32.of(pack(t), i32, settled, drop),
    text: (t: Ticket) => cls.Pending_string.of(pack(t), text, settled, drop),
    outcome: (t: Ticket) => cls.Pending_string.of(pack(t), outcome, settled, drop),
    maybeText: (t: Ticket) => cls.Pending_stringOpt.of(pack(t), maybeText, settled, drop),
    bytes: (t: Ticket) => cls.Pending_u8Arr.of(pack(t), bytes, settled, drop),
    chunk: (t: Ticket) => cls.Pending_u8Arr.of(pack(t), chunk, settled, drop),
    ok: (t: Ticket) => cls.Pending_bool.of(pack(t), ok, settled, drop),
    file: (t: Ticket) => cls.Pending_FileResult.of(pack(t), fileResult, settled, drop),
    stat: (t: Ticket) => cls.Pending_Stat.of(pack(t), stat, settled, drop),
    dir: (t: Ticket) => cls.Pending_stringArrOpt.of(pack(t), dirNames, settled, drop),
    socket: (t: Ticket) => cls.Pending_Socket.of(pack(t), socket, settled, drop),
    child: (t: Ticket) => cls.Pending_Child.of(pack(t), child, settled, drop),
  };

  const twoPaths = (from: string, to: string): Uint8Array => {
    const a = str(from);
    const bs = str(to);
    const out = new Uint8Array(4 + a.length + bs.length);
    out.set(i32le(a.length), 0);
    out.set(a, 4);
    out.set(bs, 4 + a.length);
    return out;
  };
  const flagged = (on: boolean, path: string): Uint8Array => {
    const p = str(path);
    const out = new Uint8Array(1 + p.length);
    out[0] = on ? 1 : 0;
    out.set(p, 1);
    return out;
  };
  /** `head` then `body`, with nothing in between — what `connect` and `send` expect. */
  const headed = (head: Uint8Array, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(head.length + body.length);
    out.set(head, 0);
    out.set(body, head.length);
    return out;
  };
  /** A length-prefixed head, so the host can tell where it ends — `writeFile` and `rename`. */
  const prefixed = (head: Uint8Array, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(4 + head.length + body.length);
    out.set(i32le(head.length), 0);
    out.set(head, 4);
    out.set(body, 4 + head.length);
    return out;
  };

  return cls.Cli.of(
    /*= argCount */
    () => T.i32(submit(b, OP.ARG_COUNT, EMPTY)),
    /*= arg */
    (i: number) => T.text(submit(b, OP.ARG, i32le(i))),
    /*= env */
    (name: string) => T.maybeText(submit(b, OP.ENV, str(name))),

    /*= readStdin */
    // stdin and stdout, which need no grant — see the note in platform.wac.
    () => T.bytes(submit(b, OP.READ_STDIN, EMPTY)),
    /*= write */
    // Blocking, matching `platform.wac`: these two act on the current stream, which is
    // ordered anyway, and are handed to the streaming transforms as bare funcrefs.
    (bytes: Uint8Array) => {
      try {
        collect(b, submit(b, OP.WRITE_STDOUT, bytes));
        return true;
      } catch {
        return false;   // a closed pipe is an answer, not a crash
      }
    },

    /*= readFile */
    (path: string) => T.file(submit(b, OP.READ_FILE, str(path))),
    /*= writeFile */
    (path: string, body: Uint8Array) => T.ok(submit(b, OP.WRITE_FILE, prefixed(str(path), body))),
    /*= stat */
    (path: string) => T.stat(submit(b, OP.STAT, str(path))),
    /*= readDir */
    (path: string) => T.dir(submit(b, OP.READ_DIR, str(path))),

    /*= mkdir */
    (path: string, parents: boolean) => T.ok(submit(b, OP.MKDIR, flagged(parents, path))),
    /*= remove */
    (path: string, recursive: boolean) => T.ok(submit(b, OP.REMOVE, flagged(recursive, path))),
    /*= rename */
    (from: string, to: string) => T.ok(submit(b, OP.RENAME, twoPaths(from, to))),

    /*= openInput */
    (path: string) => T.outcome(submit(b, OP.OPEN_INPUT, str(path))),
    /*= readChunk */
    () => {
      try {
        return collect(b, submit(b, OP.READ_CHUNK, EMPTY));
      } catch {
        return EMPTY;   // unreadable is indistinguishable from ended, as it should be
      }
    },
    /*= openOutput */
    (path: string) => T.outcome(submit(b, OP.OPEN_OUTPUT, str(path))),

    /*= connect */
    (host: string, port: number) => T.socket(submit(b, OP.CONNECT, headed(i32le(port), str(host)))),
    /*= listen */
    (port: number) => T.socket(submit(b, OP.LISTEN, i32le(port))),
    /*= accept */
    (handle: number) => T.socket(submit(b, OP.ACCEPT, i32le(handle))),
    /*= recv */
    (handle: number) => T.chunk(submit(b, OP.RECV, i32le(handle))),
    /*= send */
    (handle: number, body: Uint8Array) => T.ok(submit(b, OP.SEND, headed(i32le(handle), body))),
    /*= closeSocket */
    (handle: number) => { hostCall(b, OP.CLOSE_SOCKET, i32le(handle)); },

    /*= waitAny */
    // No opcode: the wait is on the completion counter in this worker's own memory, so it
    // takes no slot and the host is not involved — including the deadline, which is
    // `Atomics.wait`'s own timeout. Returns the *index* rather than the id, because the
    // caller already knows which ticket it put where, and -1 when the time ran out.
    (ids: Int32Array, millis: number) => {
      const tickets = Array.from(ids, unpack);
      const settled = waitAny(b, tickets, millis);
      if (settled === null) return -1;
      return tickets.findIndex((t) => t.slot === settled.slot && t.gen === settled.gen);
    },

    /*= spawn */
    (source: string, args: string[], grants: number) =>
      // The grant flags, then the source length-prefixed, then the arguments NUL-separated —
      // the same shape `readDir` answers with, for the same reason: a filename or an argument
      // may contain anything but a NUL.
      T.child(
        submit(
          b,
          OP.SPAWN,
          headed(i32le(grants), prefixed(str(source), str(args.join("\u0000")))),
        ),
      ),
    /*= closeFeed */
    (handle: number) => { hostCall(b, OP.CLOSE_FEED, i32le(handle)); },
    /*= exitCode */
    (handle: number) => T.i32(submit(b, OP.EXIT_CODE, i32le(handle))));
}

export { HostCallError };
