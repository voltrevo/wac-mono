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
import { WORKER_MARKER } from "../host/children.ts";
import { i32le, readI32le, str, unstr } from "../host/call.ts";
import { OP } from "../host/ops.ts";
import { FAULT_DENIED, FAULT_NOT_FOUND, STAT_BYTES, STAT_FAULT } from "../host/faults.ts";

/**
 * The bytes out of a `Read` payload: tag 0 is data, 1 is the end, 2 is a failure.
 *
 * These tests speak the wire format directly, so they see the tag that `provider.ts` decodes into a
 * `Read`. Worth decoding rather than ignoring: a test that skipped the tag byte would pass while
 * reporting one byte too many, and one that treated "end" as "no bytes" would loop for ever — which
 * is exactly what the first version of this change did.
 */
function readBytes(p: Uint8Array): Uint8Array {
  if (p.length === 0 || p[0] === 1) return new Uint8Array(0);
  if (p[0] === 2) {
    throw new Error(`the read failed: ${new TextDecoder().decode(p.subarray(1))}`);
  }
  return p.subarray(1);
}


/**
 * A `Change` payload: the fault category, and the message it carries.
 *
 * The four mutations do not reject — they answer, because their category is the thing a caller
 * branches on and an exception has nowhere to put one.
 */
function change(p: Uint8Array): { fault: number; message: string } {
  return { fault: p[0], message: new TextDecoder().decode(p.subarray(1)) };
}

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

/**
 * What a real Origin Private File System rejects with: a `DOMException`, named.
 *
 * The name is the whole point. `host/faults.ts` classifies a browser failure by
 * `DOMException.name` — there are no errno codes here — so a double that rejected with a plain
 * `Error` would put every failure in `FAULT_OTHER` and quietly agree with itself: `rm -f` would look
 * tested and would not be. This is the shape of mistake `browser_live.test.ts`'s header warns about,
 * where a double's assumptions came from the same place as the code's.
 */
function opfsError(name: string, message: string): Error {
  // `DOMException` exists in Deno, so this is the real class rather than an impression of it.
  return new DOMException(message, name);
}

/**
 * A double with one extra question: is it empty?
 *
 * A real `FileSystemDirectoryHandle` answers that only asynchronously, through `keys()`, but the
 * *parent* needs it synchronously inside `removeEntry` to decide between "not empty" and "removed".
 * A browser has the answer in memory; this double gives itself the same shortcut rather than
 * pretending `removeEntry` is more asynchronous than it is.
 */
type MemDir = DirHandle & { emptyNow(): boolean };

function memDir(): MemDir {
  const files = new Map<string, Uint8Array>();
  const dirs = new Map<string, MemDir>();
  const self: MemDir = {
    emptyNow: () => files.size === 0 && dirs.size === 0,
    getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (opts?.create !== true) {
          return Promise.reject(opfsError("NotFoundError", `no file ${name}`));
        }
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
        if (opts?.create !== true) {
          return Promise.reject(opfsError("NotFoundError", `no directory ${name}`));
        }
        dirs.set(name, memDir());
      }
      return Promise.resolve(dirs.get(name)!);
    },
    removeEntry(name, opts) {
      // A directory with anything in it is `InvalidModificationError` without `recursive`, which is
      // how a browser says "not empty" — it has no errno to say it with.
      const dir = dirs.get(name);
      if (dir !== undefined && opts?.recursive !== true && !dir.emptyNow()) {
        return Promise.reject(opfsError("InvalidModificationError", `${name} is not empty`));
      }
      if (!files.delete(name) && !dirs.delete(name)) {
        return Promise.reject(opfsError("NotFoundError", `no entry ${name}`));
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
  const absentStat = await call(OP.STAT, str("absent"));
  assertEquals(absentStat[0], 0, "absent is all zeroes");
  // And its fault byte is `FAULT_NONE`: absence is an *answer*, so `test -e` and `rm -f` keep working.
  // If this ever reported a fault, every "does it exist" check in the repo would start failing loudly.
  assertEquals(absentStat[STAT_FAULT], 0, "absence was reported as a fault");

  assertEquals(unstr(await call(OP.READ_DIR, str("a"))), "b");

  // Without -p a missing parent fails, and so does an existing directory. Both answer a `Change`
  // rather than throwing, and the second is `FAULT_EXISTS` by category — which matters here more
  // than anywhere, because OPFS has no exclusive create and the *host* decided that fault.
  const missingParent = change(await call(OP.MKDIR, new Uint8Array([0, ...str("x/y")])));
  assertEquals(missingParent.fault, 1, "a missing parent is FAULT_NOT_FOUND");
  assertEquals(missingParent.message, "no such file or directory", missingParent.message);
  const already = change(await call(OP.MKDIR, new Uint8Array([0, ...str("a")])));
  assertEquals(already.fault, 3, "already exists is FAULT_EXISTS");
  assertEquals(already.message, "already exists", already.message);

  // This host says a known category in its own short words rather than passing on the
  // `DOMException` message, which is written for a console: "A requested file or directory could
  // not be found at the time an operation was processed." reads as a defect after
  // `rm: cannot remove 'f': `. Checked against a real browser, not only this double — the demo page
  // is where it shows.
  const absent = change(await call(OP.REMOVE, new Uint8Array([0, ...str("nothing-here")])));
  assertEquals(absent.fault, 1, "FAULT_NOT_FOUND");
  assertEquals(absent.message, "no such file or directory", absent.message);
  // A directory with something in it, without `recursive`: `InvalidModificationError` in a browser,
  // which has no errno to say "not empty" with.
  const notEmpty = change(await call(OP.REMOVE, new Uint8Array([0, ...str("a")])));
  assertEquals(notEmpty.fault, 4, "FAULT_NOT_EMPTY");
  assertEquals(notEmpty.message, "directory not empty", notEmpty.message);
  // ...and a fault with no category keeps the message, because there it is the only information
  // there is. "" names no component at all, which is this host's own complaint rather than OPFS's.
  const empty = change(await call(OP.MKDIR, new Uint8Array([0])));
  assertEquals(empty.fault, 5, "FAULT_OTHER");
  assertEquals(empty.message, "empty path", empty.message);

  // Streaming input, in CHUNK-sized pieces out of a Blob.
  await put("big.txt", "x".repeat(200_000));
  await call(OP.OPEN_INPUT, str("big.txt"));
  let total = 0;
  let chunks = 0;
  for (;;) {
    const c = readBytes(await call(OP.READ_CHUNK));
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
  for (const op of [OP.CONNECT, OP.LISTEN, OP.ACCEPT, OP.SEND]) {
    await rejects(() => call(op, i32le(1)), "network access not granted");
  }
  // `recv` answers rather than rejects, because its answer is a `Read` and "there is no network" is
  // a `Failed` — a refusal the caller must handle, in the same shape as a connection that broke.
  const refused = await call(OP.RECV, i32le(1));
  assertEquals(refused[0], 2, "recv on a page answers Failed");
  assertEquals(
    new TextDecoder().decode(refused.subarray(1)).includes("network access"),
    true,
    new TextDecoder().decode(refused.subarray(1)),
  );

  // No standard input, and no environment. Both are answers rather than errors, because
  // a program with nothing piped in and no variables set already handles them.
  assertEquals((await call(OP.READ_STDIN)).length, 0);
  assertEquals((await call(OP.ENV, str("PATH")))[0], 0, "every variable is unset");
});

/**
 * The payload `spawn` takes: grants, the source, the arguments, the child's directory.
 *
 * Length-prefixed the way `provider.ts` writes it and `children.ts` reads it. Written out here rather
 * than imported because this test is checking the *host*, and a test that built its input with the
 * same helper the host parses with would agree with itself about the format.
 */
function spawnPayload(
  source: string,
  args: string[],
  grants = 0,
  cwd = "",
  inheritIn = false,
): Uint8Array {
  const src = str(source);
  const dir = str(cwd);
  // The argument vector: a count, then each argument length-prefixed. It used to be one NUL-joined blob
  // of text, which is why a non-UTF-8 argument could not survive a spawn — wac-mono 0065.
  const argv = args.map((a) => str(a));
  let argvLen = 4;
  for (const a of argv) argvLen += 4 + a.length;
  const out = new Uint8Array(13 + src.length + argvLen + dir.length);
  out.set(i32le(grants), 0);
  out.set(i32le(src.length), 4);
  out.set(src, 8);
  let at = 8 + src.length;
  out.set(i32le(argv.length), at);
  at += 4;
  for (const a of argv) {
    out.set(i32le(a.length), at);
    out.set(a, at + 4);
    at += 4 + a.length;
  }
  out.set(i32le(dir.length), at);
  out.set(dir, at + 4);
  // One byte: whether the child reads the page's own standard input rather than a queue. Issue 0042.
  out[at + 4 + dir.length] = inheritIn ? 1 : 0;
  return out;
}

Deno.test("a failed read says what a failed change says", async () => {
  // One tab should not speak with two voices. A change reports through `Change`, whose category the
  // host turns into a short phrase; a read reports by *throwing*, and its message went out as the
  // `DOMException`'s own prose — so `rm nosuchfile` said "no such file or directory" while
  // `cat nosuchfile` said "A requested file or directory could not be found at the time an operation
  // was processed." Found by driving the terminal, not by reading the code.
  const w = browserWorld({ root: memDir() });
  let said = "";
  try {
    await w[OP.READ_FILE](str("nothing-here")) as Uint8Array;
  } catch (e) {
    said = e instanceof Error ? e.message : String(e);
  }
  assertEquals(said, "no such file or directory", said);

  // `openInput` answers a `Change` now rather than throwing, so the agreement is between the phrase in
  // that answer and the phrase in the throw above — the same words either way, which is the whole claim.
  const change = await w[OP.OPEN_INPUT](str("nothing-here")) as Uint8Array;
  assertEquals(change[0], FAULT_NOT_FOUND, `fault ${change[0]}`);
  assertEquals(new TextDecoder().decode(change.subarray(1)), "no such file or directory");
});

Deno.test("a page spawns a worker of its own — 0030", async () => {
  // The unit of this is the *plumbing*: a worker is created, its load notice is waited for, its
  // handle comes back, and its exit code arrives. A child that speaks the bridge and writes output
  // is a whole wac program, and that is tested in a real browser by `browser_live.test.ts` — here a
  // handful of lines of JavaScript playing the same protocol is what keeps this test a unit.
  const w = browserWorld({});
  // The marker on the first line, because `spawnChild` refuses a source without one before starting
  // anything — a file that parses and is not a worker bundle used to wedge the caller for ever (0033).
  // A double that speaks the protocol has to say it is one, same as a built bundle does.
  const child = `${WORKER_MARKER}
    self.postMessage({ ready: true });
    self.onmessage = () => self.postMessage({ ok: true, code: 7 });
  `;
  const spawned = await w[OP.SPAWN](spawnPayload(child, ["one"])) as Uint8Array;
  const handle = readI32le(spawned);
  const errHandle = readI32le(spawned.subarray(4));
  assertEquals(handle >= 1, true, `a handle, not ${handle}: ${unstr(spawned.subarray(8))}`);
  // Two handles: a program has two output streams, and merging them made a shell count an error
  // message in `cat nosuch | wc -c`. Both are readable with `recv`, because a handle is a handle.
  assertEquals(errHandle >= 1 && errHandle !== handle, true, `a second handle, not ${errHandle}`);
  const code = readI32le(await w[OP.EXIT_CODE](i32le(handle)) as Uint8Array);
  assertEquals(code, 7, "the child's own exit code");

  // A source that is not JavaScript is a failed child with a reason, not an error that takes the
  // page down with it — the same contract the Deno host has. Issue 0021.
  const bad = await w[OP.SPAWN](spawnPayload("this is not javascript {{{", [])) as Uint8Array;
  assertEquals(readI32le(bad), -1, "would not start");
  assertEquals(readI32le(bad.subarray(4)), -1, "and has no error stream to read either");
  assertEquals(unstr(bad.subarray(8)).length > 0, true, "and says why");
});

Deno.test("the browser world denies the filesystem when the page grants none", async () => {
  const w = browserWorld({});
  const call = async (op: number, payload: Uint8Array<ArrayBufferLike> = new Uint8Array(0)) =>
    await w[op](payload as Uint8Array) as Uint8Array;

  await rejects(() => call(OP.READ_FILE, str("anything")), "filesystem read not granted");
  await rejects(() => call(OP.READ_DIR, str("anything")), "filesystem read not granted");
  // Not granted is *not* "does not exist" any more, here or under Deno: `stat` answers with
  // `FAULT_DENIED` in its fault byte, because a page that was never given a directory cannot say
  // whether a file is there and saying "it is not" is a guess. wac-mono 0065.
  const ungranted = await call(OP.STAT, str("anything"));
  assertEquals(ungranted[0], 0, "it claimed a file exists in a filesystem it cannot see");
  assertEquals(ungranted.length, STAT_BYTES, "the reply is too narrow to carry a fault");
  assertEquals(ungranted[STAT_FAULT], FAULT_DENIED, "an ungranted stat looked like absence");

  // A read-only grant still refuses every mutation.
  const ro = browserWorld({ root: memDir() });
  const roCall = async (op: number, payload: Uint8Array<ArrayBufferLike> = new Uint8Array(0)) =>
    await ro[op](payload as Uint8Array) as Uint8Array;
  // A refusal for want of a grant is `FAULT_DENIED` said in the ordinary shape, not an exception:
  // one code path in the applet for "the page said no" and "the filesystem said no".
  for (const [op, payload] of [
    [OP.MKDIR, new Uint8Array([1, ...str("d")])],
    [OP.REMOVE, new Uint8Array([0, ...str("d")])],
    [OP.WRITE_FILE, new Uint8Array([1, 0, 0, 0, ...str("f"), 120])],
    [OP.RENAME, new Uint8Array([1, 0, 0, 0, ...str("f"), ...str("g")])],
  ] as [number, Uint8Array][]) {
    const c = change(await roCall(op, payload));
    assertEquals(c.fault, 2, `op ${op} is FAULT_DENIED`);
    assertEquals(c.message.includes("write not granted"), true, c.message);
  }
  await rejects(() => roCall(OP.OPEN_OUTPUT, str("f")), "write not granted");
});
