// Deno's implementation of the world, on the main thread.
//
// Note how much of this is `await`. That is the reason the bridge exists: none of these
// are things wac could have called directly, and with the bridge the wac side does not
// know the difference.

import { type Handlers } from "./respond.ts";
import { i32le, i64le, readI32le, str, unstr } from "./call.ts";
import { OP } from "./ops.ts";

export type DenoWorldOptions = {
  /** Arguments the application sees. Defaults to none, not to the launcher's own. */
  args?: string[];
  /** Where output goes. Defaults to the console. */
  log?(line: string): void;
  warn?(line: string): void;
  /** Restrict the filesystem, or leave it out for none at all. */
  fs?: { read?: boolean; write?: boolean };
  /** Environment lookups, or leave it out to report every variable unset. */
  env?(name: string): string | undefined;
};

const EMPTY = new Uint8Array(0);

/** All of standard input. Deno needs no permission for this, and neither does the world. */
async function readAllStdin(): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const buf = new Uint8Array(65536);
  for (;;) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    parts.push(buf.slice(0, n));
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function writeAllStdout(bytes: Uint8Array): Promise<void> {
  let at = 0;
  while (at < bytes.length) at += await Deno.stdout.write(bytes.subarray(at));
}

/**
 * The handler table for Deno.
 *
 * What is absent is as much the interface as what is present: with no `fs` option, a
 * `readFile` reports "filesystem not granted" rather than reading anything. The
 * application cannot tell the difference between a capability the host declined and one
 * that failed, which is the correct amount for it to know.
 */
async function denoDir(path: string): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(path)) names.push(e.name);
  return names.sort();
}

export function denoWorld(opts: DenoWorldOptions = {}): Handlers {
  const args = opts.args ?? [];
  const log = opts.log ?? ((l: string) => console.log(l));
  const warn = opts.warn ?? ((l: string) => console.error(l));
  const deny = (what: string) => { throw new Error(`${what} not granted to this application`); };

  return {
    [OP.NOW_MILLIS]: () => i64le(BigInt(Date.now())),
    [OP.MONOTONIC_NANOS]: () => i64le(BigInt(Math.round(performance.now() * 1e6))),
    [OP.RANDOM_BYTES]: (p) => {
      const n = readI32le(p);
      if (n < 0 || n > 1 << 20) throw new Error(`randomBytes(${n}) out of range`);
      return crypto.getRandomValues(new Uint8Array(n));
    },
    [OP.LOG]: (p) => { log(unstr(p)); return EMPTY; },
    [OP.WARN]: (p) => { warn(unstr(p)); return EMPTY; },

    [OP.ARG_COUNT]: () => i32le(args.length),
    [OP.ARG]: (p) => {
      const i = readI32le(p);
      return str(i >= 0 && i < args.length ? args[i] : "");
    },
    [OP.ENV]: (p) => {
      const v = opts.env?.(unstr(p));
      if (v === undefined) return new Uint8Array([0]);
      const b = str(v);
      const out = new Uint8Array(1 + b.length);
      out[0] = 1;
      out.set(b, 1);
      return out;
    },

    // Genuinely asynchronous, and the wac side calls it like a function.
    [OP.READ_FILE]: async (p) => {
      if (!opts.fs?.read) deny("filesystem read");
      return await Deno.readFile(unstr(p));
    },

    // stdin and stdout need no grant: what the user pipes in and what the program prints
    // are the user's own doing, not a reach into something they did not offer.
    [OP.READ_STDIN]: async () => await readAllStdin(),
    [OP.WRITE_STDOUT]: async (p) => { await writeAllStdout(p); return EMPTY; },

    [OP.STAT]: async (p) => {
      const out = new Uint8Array(19);
      const dv = new DataView(out.buffer);
      if (!opts.fs?.read) return out; // not granted reads as "does not exist"
      try {
        const st = await Deno.stat(unstr(p));
        out[0] = 1;
        out[1] = st.isFile ? 1 : 0;
        out[2] = st.isDirectory ? 1 : 0;
        dv.setBigInt64(3, BigInt(st.size), true);
        dv.setBigInt64(11, BigInt(st.mtime?.getTime() ?? 0), true);
      } catch { /* absent, and the zeroes say so */ }
      return out;
    },
    [OP.READ_DIR]: async (p) => {
      if (!opts.fs?.read) deny("filesystem read");
      const names = await denoDir(unstr(p));
      return str(names.join("\u0000"));
    },
    [OP.WRITE_FILE]: async (p) => {
      if (!opts.fs?.write) deny("filesystem write");
      const n = readI32le(p);
      const path = unstr(p.subarray(4, 4 + n));
      await Deno.writeFile(path, p.subarray(4 + n));
      return EMPTY;
    },
  };
}
