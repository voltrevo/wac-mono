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

Deno.test("the page capabilities, against a document that only records", async () => {
  // The `Dom` is injected exactly as the OPFS root is, so this drives the handlers without a
  // browser. What it cannot check is delegation and the real event plumbing — those live in
  // `entryBrowser.ts` and are covered by `browser_live.test.ts` clicking real buttons, which
  // is the split this file learned the hard way with `readDir(".")`.
  const did: string[] = [];
  const events = [
    { kind: "click", id: "go", value: "", x: 0, y: 0 },
    { kind: "input", id: "box", value: "typed", x: 0, y: 0 },
    { kind: "pointermove", id: "c", value: "", x: 17, y: 42 },
  ];
  const files = [
    { ok: true, name: "given.txt", bytes: str("its bytes"), error: "" },
    { ok: false, name: "bad.bin", bytes: new Uint8Array(0), error: "unreadable" },
  ];
  const w = browserWorld({
    dom: {
      render: (html) => did.push(`render:${html}`),
      setText: (id, t) => did.push(`setText:${id}=${t}`),
      setValue: (id, v) => did.push(`setValue:${id}=${v}`),
      value: (id) => (id === "box" ? "in the box" : ""),
      on: (sel, kind) => did.push(`on:${sel}/${kind}`),
      title: (t) => did.push(`title:${t}`),
      next: () => Promise.resolve(events.shift() ?? { kind: "", id: "", value: "", x: 0, y: 0 }),
      drawPixels: (id, w, h, rgba) => did.push(`draw:${id}/${w}x${h}/${rgba.length}b`),
      nextFile: () =>
        Promise.resolve(files.shift() ?? { ok: false, name: "", bytes: new Uint8Array(0), error: "none" }),
      offerDownload: (name, bytes) => did.push(`download:${name}/${bytes.length}b`),
    },
  });
  const call = async (op: number, payload: Uint8Array<ArrayBufferLike> = new Uint8Array(0)) =>
    await w[op](payload as Uint8Array) as Uint8Array;
  const two = (a: string, b: string) => {
    const x = str(a);
    const y = str(b);
    const out = new Uint8Array(4 + x.length + y.length);
    out.set(i32le(x.length), 0);
    out.set(x, 4);
    out.set(y, 4 + x.length);
    return out;
  };

  await call(OP.RENDER, str("<b>hi</b>"));
  await call(OP.SET_TEXT, two("out", "answer"));
  await call(OP.SET_VALUE, two("box", "seeded"));
  await call(OP.ON, two("button", "click"));
  await call(OP.TITLE, str("demo"));
  assertEquals(
    did.join(" "),
    "render:<b>hi</b> setText:out=answer setValue:box=seeded on:button/click title:demo",
  );
  assertEquals(unstr(await call(OP.GET_VALUE, str("box"))), "in the box");

  // NUL-separated fields, in the order `Event` declares them, coordinates included.
  assertEquals(unstr(await call(OP.NEXT_EVENT)).split("\u0000").join("|"), "click|go||0|0");
  assertEquals(unstr(await call(OP.NEXT_EVENT)).split("\u0000").join("|"), "input|box|typed|0|0");
  assertEquals(unstr(await call(OP.NEXT_EVENT)).split("\u0000").join("|"), "pointermove|c||17|42");

  // A pixel buffer: width, height, the id length-prefixed, then the bytes.
  const blit = new Uint8Array(12 + 1 + 2 * 3 * 4);
  blit.set(i32le(2), 0);
  blit.set(i32le(3), 4);
  blit.set(i32le(1), 8);
  blit.set(str("c"), 12);
  await call(OP.DRAW_PIXELS, blit);
  assertEquals(did[did.length - 1], "draw:c/2x3/24b");
  // A buffer that does not match the size is caught here rather than several layers down.
  const short = new Uint8Array(12 + 1 + 4);
  short.set(i32le(2), 0);
  short.set(i32le(3), 4);
  short.set(i32le(1), 8);
  short.set(str("c"), 12);
  await rejects(() => call(OP.DRAW_PIXELS, short), "needs 24 bytes, got 4");

  // A file in: a flag, the name, the error, then the bytes.
  // Offsets computed rather than written out: the first attempt hardcoded them and was four
  // bytes off, which read as the file's own bytes being wrong.
  const unpick = (b: Uint8Array) => {
    const nameLen = readI32le(b.subarray(1));
    const errLen = readI32le(b.subarray(5 + nameLen));
    return {
      ok: b[0] === 1,
      name: unstr(b.subarray(5, 5 + nameLen)),
      error: unstr(b.subarray(9 + nameLen, 9 + nameLen + errLen)),
      bytes: unstr(b.subarray(9 + nameLen + errLen)),
    };
  };
  assertEquals(JSON.stringify(unpick(await call(OP.NEXT_FILE))),
    JSON.stringify({ ok: true, name: "given.txt", error: "", bytes: "its bytes" }));
  // And one that could not be read, which is a `Picked` carrying a reason rather than a throw.
  assertEquals(JSON.stringify(unpick(await call(OP.NEXT_FILE))),
    JSON.stringify({ ok: false, name: "bad.bin", error: "unreadable", bytes: "" }));

  // A file out.
  const out = new Uint8Array(4 + 5 + 3);
  out.set(i32le(5), 0);
  out.set(str("a.txt"), 4);
  out.set(str("xyz"), 9);
  await call(OP.OFFER_DOWNLOAD, out);
  assertEquals(did[did.length - 1], "download:a.txt/3b");
});

Deno.test("a page with no dom refuses to draw, rather than doing nothing", async () => {
  // The same shape as withholding the filesystem: an application that believes it has drawn
  // something and has not is worse off than one told plainly that it cannot.
  const w = browserWorld({});
  await rejects(() => w[OP.RENDER](str("<b>hi</b>")) as Promise<Uint8Array>, "not granted");
  await rejects(() => w[OP.NEXT_EVENT](new Uint8Array(0)) as Promise<Uint8Array>, "not granted");
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
