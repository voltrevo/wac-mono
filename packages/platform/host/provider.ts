// Worker side: turn a bridge into the capability structs a wac application receives.
//
// Every closure here is created **once per application**, never per call. bindgen
// registers each distinct function identity in a fixed table of sixteen per signature and
// never frees a slot, so a fresh closure per call dies on the seventeenth with a
// `RangeError` a long way from its cause. `packages/stream` hit this and its README says
// the same thing: hold stable functions and put the varying part in their arguments.

import { type Bridge } from "./layout.ts";
import { hostCall, i32le, readI32le, readI64le, str, unstr } from "./call.ts";
import { OP } from "./ops.ts";

/** The generated classes this needs from a module that imports `platform.wac`. */
export type PlatformClasses = {
  Core: { of(...caps: unknown[]): unknown };
  Cli: { of(...caps: unknown[]): unknown };
  FileResult: { of?(...a: unknown[]): unknown };
};

/**
 * `Core`, built from the bridge.
 *
 * Each capability is an ordinary JavaScript function as far as wac is concerned. That it
 * parks a thread and waits for another one to answer is invisible from the wac side,
 * which is the entire point: the application is straight-line code.
 */
export function coreOf(b: Bridge, cls: { Core: PlatformClasses["Core"] }): unknown {
  return cls.Core.of(
    () => readI64le(hostCall(b, OP.NOW_MILLIS, new Uint8Array(0))),
    () => readI64le(hostCall(b, OP.MONOTONIC_NANOS, new Uint8Array(0))),
    (n: number) => hostCall(b, OP.RANDOM_BYTES, i32le(n)),
    (line: string) => { hostCall(b, OP.LOG, str(line)); },
    (line: string) => { hostCall(b, OP.WARN, str(line)); },
  );
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
  },
): unknown {
  const mk = {
    fileResult: (ok: boolean, bytes: Uint8Array, error: string) =>
      cls.FileResult.of(ok, bytes, error),
  };
  return cls.Cli.of(
    () => readI32le(hostCall(b, OP.ARG_COUNT, new Uint8Array(0))),
    (i: number) => unstr(hostCall(b, OP.ARG, i32le(i))),
    (name: string) => {
      const out = hostCall(b, OP.ENV, str(name));
      // One byte of presence in front, because an unset variable and an empty one are
      // different and a bare empty payload cannot say which this is.
      return out[0] === 1 ? unstr(out.subarray(1)) : null;
    },
    // stdin and stdout, which need no grant — see the note in platform.wac.
    () => hostCall(b, OP.READ_STDIN, new Uint8Array(0)),
    (bytes: Uint8Array) => {
      try {
        hostCall(b, OP.WRITE_STDOUT, bytes);
        return true;
      } catch {
        return false;   // a closed pipe is an answer, not a crash
      }
    },
    (path: string) => {
      try {
        return mk.fileResult(true, hostCall(b, OP.READ_FILE, str(path)), "");
      } catch (e) {
        return mk.fileResult(false, new Uint8Array(0), e instanceof Error ? e.message : String(e));
      }
    },
    (path: string, bytes: Uint8Array) => {
      const p = str(path);
      const payload = new Uint8Array(4 + p.length + bytes.length);
      payload.set(i32le(p.length), 0);
      payload.set(p, 4);
      payload.set(bytes, 4 + p.length);
      try {
        hostCall(b, OP.WRITE_FILE, payload);
        return true;
      } catch {
        return false;
      }
    },
    (path: string) => {
      try {
        const out = hostCall(b, OP.STAT, str(path));
        // exists, isFile, isDir as bytes, then size and mtime as little-endian i64s.
        const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
        return cls.Stat.of(
          out[0] === 1, out[1] === 1, out[2] === 1,
          dv.getBigInt64(3, true), dv.getBigInt64(11, true),
        );
      } catch {
        return cls.Stat.of(false, false, false, 0n, 0n);
      }
    },
    (path: string) => {
      try {
        const out = hostCall(b, OP.READ_DIR, str(path));
        if (out.length === 0) return [];
        // NUL-separated: a filename may contain anything but a NUL or a slash.
        return unstr(out).split("\u0000");
      } catch {
        return null;
      }
    },
    // A leading flag byte rather than two opcodes: `mkdir -p` and `mkdir` differ in one
    // bit of intent, and one handler that reads it keeps them from drifting apart.
    (path: string, parents: boolean) => tried(b, OP.MKDIR, flagged(parents, path)),
    (path: string, recursive: boolean) => tried(b, OP.REMOVE, flagged(recursive, path)),
    (from: string, to: string) => tried(b, OP.RENAME, twoPaths(from, to)),
    (path: string) => {
      try {
        hostCall(b, OP.OPEN_INPUT, str(path));
        return "";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    () => {
      try {
        return hostCall(b, OP.READ_CHUNK, new Uint8Array(0));
      } catch {
        return new Uint8Array(0);   // unreadable is indistinguishable from ended, as it should be
      }
    },
  );
}

/** An op whose only answer is whether it worked. */
function tried(b: Bridge, op: number, payload: Uint8Array): boolean {
  try {
    hostCall(b, op, payload);
    return true;
  } catch {
    return false;
  }
}

function flagged(on: boolean, path: string): Uint8Array {
  const p = str(path);
  const out = new Uint8Array(1 + p.length);
  out[0] = on ? 1 : 0;
  out.set(p, 1);
  return out;
}

function twoPaths(from: string, to: string): Uint8Array {
  const a = str(from);
  const bs = str(to);
  const out = new Uint8Array(4 + a.length + bs.length);
  out.set(i32le(a.length), 0);
  out.set(a, 4);
  out.set(bs, 4 + a.length);
  return out;
}
