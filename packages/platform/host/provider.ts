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
  cls: { Cli: PlatformClasses["Cli"]; FileResult: { of(...a: unknown[]): unknown } },
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
  );
}
