// The browser world's capability mapping.
//
// There is no browser in this container, so what is tested here is the part that would be
// wrong if the mapping were wrong: the handlers themselves, driven with the payloads the
// bridge would carry, over an in-memory Origin Private File System.
//
// A double is not the thing, and the difference showed: `readDir(".")` passed here for a week
// and answered "not a directory" in Chromium, because OPFS has no `.` entry and this double's
// path handling was written from the same assumption as the code it was checking. The browser
// is in the container now — see `browser_live.test.ts`, which runs the page for real — and the
// case below is the one it caught.

import { browserWorld, type DirHandle, type FileHandle } from "../host/browser.ts";
import { i32le, readI32le, str, unstr } from "../host/call.ts";
import { OP } from "../host/ops.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

async function rejects(fn: () => unknown | Promise<unknown>, contains: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (!m.includes(contains)) throw new Error(`expected "${contains}", got "${m}"`);
    return;
  }
  throw new Error(`expected a rejection containing "${contains}"`);
}

// ── An Origin Private File System, in memory ──────────────────────────────────
// Only the four methods `browser.ts` uses. A fake rather than a mock: it really stores
// bytes and really has a hierarchy, so a path bug shows up as a wrong answer here too.

function memDir(): DirHandle {
  const files = new Map<string, Uint8Array>();
  const dirs = new Map<string, DirHandle>();
  const self: DirHandle = {
    getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (opts?.create !== true) return Promise.reject(new Error(`no file ${name}`));
        files.set(name, new Uint8Array(0));
      }
      const h: FileHandle = {
        getFile: () => {
          const b = files.get(name)!;
          const blob = new Blob([b as BufferSource]) as Blob & {
            size: number;
            lastModified: number;
          };
          // A Blob has `size`; `lastModified` is a File's, and the world only reads it.
          Object.defineProperty(blob, "lastModified", { value: 1_700_000_000_000 });
          return Promise.resolve(blob);
        },
        createWritable: () => {
          const parts: Uint8Array[] = [];
          return Promise.resolve({
            write: (d: Uint8Array) => { parts.push(d.slice()); return Promise.resolve(); },
            close: () => {
              const total = parts.reduce((n, p) => n + p.length, 0);
              const out = new Uint8Array(total);
              let at = 0;
              for (const p of parts) { out.set(p, at); at += p.length; }
              files.set(name, out);
              return Promise.resolve();
            },
          });
        },
      };
      return Promise.resolve(h);
    },
    getDirectoryHandle(name, opts) {
      if (!dirs.has(name)) {
        if (opts?.create !== true) return Promise.reject(new Error(`no directory ${name}`));
        dirs.set(name, memDir());
      }
      return Promise.resolve(dirs.get(name)!);
    },
    removeEntry(name) {
      if (!files.delete(name) && !dirs.delete(name)) {
        return Promise.reject(new Error(`no entry ${name}`));
      }
      return Promise.resolve();
    },
    keys: () => (async function* () {
      for (const k of [...files.keys(), ...dirs.keys()]) yield k;
    })(),
  };
  return self;
}

const dec = new TextDecoder();

Deno.test("the browser world honours the capabilities a page can honour", async () => {
  const root = memDir();
  const logged: string[] = [];
  const written: Uint8Array[] = [];
  const w = browserWorld({
    args: ["one", "two"],
    log: (l) => logged.push(l),
    warn: (l) => logged.push(`!${l}`),
    write: (b) => written.push(b),
    root,
    writable: true,
  });
  const call = async (op: number, payload: Uint8Array<ArrayBufferLike> = new Uint8Array(0)) =>
    await w[op](payload as Uint8Array) as Uint8Array;

  assertEquals(readI32le(await call(OP.ARG_COUNT)), 2);
  assertEquals(unstr(await call(OP.ARG, i32le(1))), "two");
  // Out of range is empty, not an error — the same as everywhere else.
  assertEquals(unstr(await call(OP.ARG, i32le(9))), "");

  await call(OP.LOG, str("hello"));
  await call(OP.WARN, str("careful"));
  assertEquals(logged.join(","), "hello,!careful");

  assertEquals((await call(OP.RANDOM_BYTES, i32le(16))).length, 16);
  await rejects(() => call(OP.RANDOM_BYTES, i32le(-1)), "out of range");

  // Files, through OPFS. A path with directories in it has to walk them.
  const put = (path: string, body: string) => {
    const p = str(path);
    const b = str(body);
    const payload = new Uint8Array(4 + p.length + b.length);
    payload.set(i32le(p.length), 0);
    payload.set(p, 4);
    payload.set(b, 4 + p.length);
    return call(OP.WRITE_FILE, payload);
  };
  await put("notes.txt", "hello\n");
  assertEquals(dec.decode(await call(OP.READ_FILE, str("notes.txt"))), "hello\n");

  await call(OP.MKDIR, new Uint8Array([1, ...str("a/b/c")]));
  await put("a/b/c/deep.txt", "down here\n");
  assertEquals(dec.decode(await call(OP.READ_FILE, str("a/b/c/deep.txt"))), "down here\n");
  // Leading slashes are dropped, not treated as absolute: there is nothing above the root.
  assertEquals(dec.decode(await call(OP.READ_FILE, str("/notes.txt"))), "hello\n");

  const stat = await call(OP.STAT, str("notes.txt"));
  assertEquals(stat[0], 1, "exists");
  assertEquals(stat[1], 1, "is a file");
  assertEquals(new DataView(stat.buffer, stat.byteOffset).getBigInt64(3, true), 6n, "size");
  const dstat = await call(OP.STAT, str("a"));
  assertEquals(dstat[0], 1, "the directory exists");
  assertEquals(dstat[2], 1, "and is a directory");
  assertEquals((await call(OP.STAT, str("absent")))[0], 0, "absent is all zeroes");

  assertEquals(unstr(await call(OP.READ_DIR, str("a"))), "b");

  // Without -p a missing parent fails, and so does an existing directory.
  await rejects(() => call(OP.MKDIR, new Uint8Array([0, ...str("x/y")])), "no directory");
  await rejects(() => call(OP.MKDIR, new Uint8Array([0, ...str("a")])), "already exists");

  // Streaming input, in CHUNK-sized pieces out of a Blob.
  await put("big.txt", "x".repeat(200_000));
  await call(OP.OPEN_INPUT, str("big.txt"));
  let total = 0;
  let chunks = 0;
  for (;;) {
    const c = await call(OP.READ_CHUNK);
    if (c.length === 0) break;
    total += c.length;
    chunks++;
  }
  assertEquals(total, 200_000, "the whole file arrived");
  assertEquals(chunks > 1, true, "and in more than one chunk");

  // Streaming output: `write` follows the current output, as it does everywhere else.
  await call(OP.OPEN_OUTPUT, str("out.txt"));
  await call(OP.WRITE_STDOUT, str("first "));
  await call(OP.WRITE_STDOUT, str("second"));
  await call(OP.OPEN_OUTPUT, str(""));            // back to the page, which closes the file
  assertEquals(dec.decode(await call(OP.READ_FILE, str("out.txt"))), "first second");
  await call(OP.WRITE_STDOUT, str("to the page"));
  assertEquals(dec.decode(written[written.length - 1]), "to the page");

  // Rename, which a page cannot do atomically — it is a copy and a delete.
  const from = str("notes.txt");
  const to = str("renamed.txt");
  const mv = new Uint8Array(4 + from.length + to.length);
  mv.set(i32le(from.length), 0);
  mv.set(from, 4);
  mv.set(to, 4 + from.length);
  await call(OP.RENAME, mv);
  assertEquals(dec.decode(await call(OP.READ_FILE, str("renamed.txt"))), "hello\n");
  assertEquals((await call(OP.STAT, str("notes.txt")))[0], 0, "the old name is gone");

  await call(OP.REMOVE, new Uint8Array([0, ...str("renamed.txt")]));
  assertEquals((await call(OP.STAT, str("renamed.txt")))[0], 0, "removed");
});

Deno.test('the root is reachable as "." and as ""', async () => {
  // Deno and Node both answer `.` with the listing, so portable code says `.` and a page has to
  // mean the same thing by it. OPFS has no such entry: the root is a handle you are given, not
  // a name you can look up, so every spelling of "here" has to resolve to nothing at all and
  // then to that handle.
  const w = browserWorld({ root: memDir(), writable: true });
  const call = async (op: number, payload: Uint8Array<ArrayBufferLike> = new Uint8Array(0)) =>
    await w[op](payload as Uint8Array) as Uint8Array;

  const name = str("a.txt");
  const body = str("one");
  const put = new Uint8Array(4 + name.length + body.length);
  put.set(i32le(name.length), 0);
  put.set(name, 4);
  put.set(body, 4 + name.length);
  await call(OP.WRITE_FILE, put);

  const mk = new Uint8Array(1 + 3);
  mk.set(str("sub"), 1);
  await call(OP.MKDIR, mk);

  for (const here of [".", "", "./", "/"]) {
    assertEquals(
      unstr(await call(OP.READ_DIR, str(here))).split("\u0000").join(","),
      "a.txt,sub",
      `readDir(${JSON.stringify(here)})`,
    );
    const st = await call(OP.STAT, str(here));
    assertEquals(st[0], 1, `stat(${JSON.stringify(here)}).exists`);
    assertEquals(st[2], 1, `stat(${JSON.stringify(here)}).isDir`);
  }
});

Deno.test("the browser world refuses what a page cannot do", async () => {
  const w = browserWorld({ root: memDir(), writable: true });
  const call = async (op: number, payload: Uint8Array<ArrayBufferLike> = new Uint8Array(0)) =>
    await w[op](payload as Uint8Array) as Uint8Array;

  // The finding this whole exercise was for: a page has no TCP. `fetch` is not a socket
  // and neither is a WebSocket, so `connect` is absent rather than approximated — an
  // application gets an error it can report, not one protocol that works by accident.
  for (const op of [OP.CONNECT, OP.LISTEN, OP.ACCEPT, OP.RECV, OP.SEND]) {
    await rejects(() => call(op, i32le(1)), "network access not granted");
  }

  // No standard input, and no environment. Both are answers rather than errors, because
  // a program with nothing piped in and no variables set already handles them.
  assertEquals((await call(OP.READ_STDIN)).length, 0);
  assertEquals((await call(OP.ENV, str("PATH")))[0], 0, "every variable is unset");
});

Deno.test("the browser world denies the filesystem when the page grants none", async () => {
  const w = browserWorld({});
  const call = async (op: number, payload: Uint8Array<ArrayBufferLike> = new Uint8Array(0)) =>
    await w[op](payload as Uint8Array) as Uint8Array;

  await rejects(() => call(OP.READ_FILE, str("anything")), "filesystem read not granted");
  await rejects(() => call(OP.READ_DIR, str("anything")), "filesystem read not granted");
  // Not granted reads as "does not exist", the same as under Deno.
  assertEquals((await call(OP.STAT, str("anything")))[0], 0);

  // A read-only grant still refuses every mutation.
  const ro = browserWorld({ root: memDir() });
  const roCall = async (op: number, payload: Uint8Array<ArrayBufferLike> = new Uint8Array(0)) =>
    await ro[op](payload as Uint8Array) as Uint8Array;
  await rejects(() => roCall(OP.MKDIR, new Uint8Array([1, ...str("d")])), "write not granted");
  await rejects(() => roCall(OP.REMOVE, new Uint8Array([0, ...str("d")])), "write not granted");
  await rejects(() => roCall(OP.OPEN_OUTPUT, str("f")), "write not granted");
});
