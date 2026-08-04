// The world, end to end: a wac application with no TypeScript of its own, run on a
// worker, calling capabilities the host answers asynchronously.
//
// The central claim is that an `await` on the main thread is invisible from wac. These
// tests are what makes that a measurement — `readFile` really is `await Deno.readFile`,
// and the wac side really does call it as a function.

import { buildApp, type Grants } from "../build.ts";
import { denoWorld } from "../host/deno.ts";
import { newBridge } from "../host/layout.ts";
import { serveHostCalls } from "../host/respond.ts";
import { hostCall, HostCallError, str, unstr } from "../host/call.ts";

const WC = "packages/platform/example/wc.wac";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/**
 * Build the application and run it, which is what `deno task app` does and what ships.
 *
 * These tests used to call a `runApp` that compiled and spawned a worker by a route of
 * its own — a second launcher and a second worker, green while the real artifact was
 * broken. There is one path now, so this is slower and means something.
 */
async function runBuilt(
  args: string[],
  grants: Grants = {},
  env: Record<string, string> = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
  const built = await Deno.makeTempFile({ prefix: "wac-test-" });
  try {
    await buildApp(WC, built, grants);
    const r = new Deno.Command(built, { args, env, stdout: "piped", stderr: "piped" }).outputSync();
    const lines = (b: Uint8Array) =>
      new TextDecoder().decode(b).split("\n").filter((l) => l.length > 0);
    return { code: r.code, out: lines(r.stdout), err: lines(r.stderr) };
  } finally {
    await Deno.remove(built);
  }
}

Deno.test("an application written entirely in wac runs, and agrees with wc", async () => {
  const r = await runBuilt([WC], { read: true });
  assertEquals(r.code, 0, r.err.join("\n"));
  const [lines, words, bytes] = r.out[0].split(/\s+/);
  const text = await Deno.readTextFile(WC);
  assertEquals(Number(bytes), new TextEncoder().encode(text).length, "bytes");
  assertEquals(Number(lines), text.split("\n").length - 1, "lines");
  assertEquals(Number(words), text.split(/\s+/).filter((w) => w.length > 0).length, "words");
});

Deno.test("a capability the build withholds is a failure the application can report", async () => {
  // Built with no grants, so the world has no filesystem. The application gets an
  // ordinary failed FileResult rather than an exception, and decides what to do.
  const r = await runBuilt([WC]);
  assertEquals(r.code, 1, "the application reported failure");
  assertEquals(r.err.length, 1);
  assertEquals(r.err[0].includes("not granted"), true, `got: ${r.err[0]}`);
  assertEquals(r.out.length, 0, "and printed no counts");
});

Deno.test("a missing file reaches the application as its host's message", async () => {
  const r = await runBuilt(["no/such/file"], { read: true });
  assertEquals(r.code, 1);
  assertEquals(r.err[0].includes("no/such/file"), true, `got: ${r.err[0]}`);
});

Deno.test("no arguments means standard input, as wc has always meant it", async () => {
  // Piped explicitly: a program that reads stdin blocks on a terminal, which is correct
  // behaviour and a hung test if the pipe is left to chance.
  const r = await runFilter(WC, [], new TextEncoder().encode("one two\nthree\n"));
  assertEquals(r.code, 0, r.err);
  assertEquals(new TextDecoder().decode(r.out).trim(), "2 3 14");
});

Deno.test("env distinguishes unset from empty", async () => {
  // An empty value is still *set*, so the timing line appears. A nullable string is what
  // makes the difference expressible at all — it is why `string?` had to cross.
  const set = await runBuilt([WC], { read: true, env: true }, { WC_VERBOSE: "" });
  assertEquals(set.out.length, 2, `expected the timing line, got ${JSON.stringify(set.out)}`);
  assertEquals(set.out[1].startsWith("counted in "), true);

  const unset = await runBuilt([WC], { read: true, env: true });
  assertEquals(unset.out.length, 1, "unset means absent");
});

// ── The bridge itself ─────────────────────────────────────────────────────────

Deno.test("the bridge carries a response larger than its buffer", async () => {
  // A `readFile` of something bigger than the window must not become an error nobody
  // expected, so an oversized response arrives in chunks and is rejoined.
  const b = newBridge();
  // getRandomValues caps at 64KiB per call, so this is filled in blocks. Random rather
  // than a pattern so a chunk delivered twice, or out of order, cannot look correct.
  const big = new Uint8Array(3_000_000);
  for (let at = 0; at < big.length; at += 65536) {
    crypto.getRandomValues(big.subarray(at, Math.min(at + 65536, big.length)));
  }
  const responder = serveHostCalls(b, { 1: () => big });

  // The blocking side must not run on this thread — it would deadlock against the
  // responder. A worker is the only place `hostCall` is legal.
  const worker = new Worker(
    import.meta.resolve("./worker_probe.ts"),
    { type: "module" },
  );
  const got = await new Promise<{ len: number; first: number; last: number }>((res, rej) => {
    worker.onmessage = (e) => res(e.data);
    worker.onerror = (e) => rej(new Error(e.message));
    worker.postMessage({ sab: b.sab, op: 1, payload: new Uint8Array(0) });
  });
  responder.stop();
  worker.terminate();

  assertEquals(got.len, big.length, "every byte arrived");
  assertEquals(got.first, big[0]);
  assertEquals(got.last, big[big.length - 1]);
});

Deno.test("a capability that throws becomes an error in the application", async () => {
  const b = newBridge();
  const responder = serveHostCalls(b, {
    1: () => { throw new Error("the disk is on fire"); },
  });
  const worker = new Worker(import.meta.resolve("./worker_probe.ts"), { type: "module" });
  const got = await new Promise<{ error: string }>((res, rej) => {
    worker.onmessage = (e) => res(e.data);
    worker.onerror = (e) => rej(new Error(e.message));
    worker.postMessage({ sab: b.sab, op: 1, payload: new Uint8Array(0) });
  });
  responder.stop();
  worker.terminate();
  assertEquals(got.error, "the disk is on fire");
});

Deno.test("an unknown opcode is reported rather than hanging", async () => {
  const b = newBridge();
  const responder = serveHostCalls(b, {});
  const worker = new Worker(import.meta.resolve("./worker_probe.ts"), { type: "module" });
  const got = await new Promise<{ error: string }>((res, rej) => {
    worker.onmessage = (e) => res(e.data);
    worker.onerror = (e) => rej(new Error(e.message));
    worker.postMessage({ sab: b.sab, op: 99, payload: new Uint8Array(0) });
  });
  responder.stop();
  worker.terminate();
  assertEquals(got.error.includes("no handler for capability 99"), true, got.error);
});

Deno.test("a slow capability blocks the caller and nothing else", async () => {
  // The whole mechanism in one assertion: the handler takes 50ms of real asynchronous
  // time, the worker is parked for it, and the main thread stays free — which is why
  // the timer that resolves it can run at all.
  const b = newBridge();
  let mainThreadRan = 0;
  const ticker = setInterval(() => { mainThreadRan++; }, 5);
  const responder = serveHostCalls(b, {
    1: async () => {
      await new Promise((r) => setTimeout(r, 50));
      return str("late");
    },
  });
  const worker = new Worker(import.meta.resolve("./worker_probe.ts"), { type: "module" });
  const got = await new Promise<{ text: string }>((res, rej) => {
    worker.onmessage = (e) => res(e.data);
    worker.onerror = (e) => rej(new Error(e.message));
    worker.postMessage({ sab: b.sab, op: 1, payload: new Uint8Array(0), asText: true });
  });
  clearInterval(ticker);
  responder.stop();
  worker.terminate();
  assertEquals(got.text, "late", "the worker waited for it");
  assertEquals(mainThreadRan > 2, true, `main thread kept running (${mainThreadRan} ticks)`);
});

// Keeps the linter honest about the imports this file uses only through the worker.
void hostCall;
void HostCallError;
void unstr;
void denoWorld;

// ── The bundled executable ────────────────────────────────────────────────────

Deno.test("an application builds to one executable file and runs repeatedly", async () => {
  // Built once, run several times on purpose. The first version of this worked one run
  // in three: the launcher's `postMessage` reached the worker while the generated module
  // was suspended at its top-level `await WebAssembly.instantiate`, and was dropped.
  // A single run would have called that a pass.
  const { buildApp } = await import("../build.ts");
  const out = await Deno.makeTempFile({ prefix: "wac-app-" });
  try {
    await buildApp(WC, out, { read: true });
    const stat = await Deno.stat(out);
    assertEquals(stat.mode !== null && (stat.mode & 0o111) !== 0, true, "executable");
    assertEquals(
      (await Deno.readTextFile(out)).split("\n")[0],
      "#!/usr/bin/env -S deno run --allow-read",
      "the shebang states the grants and nothing more",
    );

    for (let i = 0; i < 3; i++) {
      // No permission flags and no separator: a built program takes the arguments a
      // program takes. What it may *do* was decided at build.
      const r = new Deno.Command(out, { args: [WC], stdout: "piped", stderr: "piped" })
        .outputSync();
      const stdout = new TextDecoder().decode(r.stdout).trim();
      assertEquals(r.code, 0, `run ${i}: ${new TextDecoder().decode(r.stderr)}`);
      assertEquals(stdout.endsWith(WC), true, `run ${i} counted the file: ${stdout}`);
    }

    // The same application built without the grant: the capability is simply absent, and
    // nothing the caller passes can put it back.
    const bare = await Deno.makeTempFile({ prefix: "wac-app-nofs-" });
    try {
      await buildApp(WC, bare);
      const denied = new Deno.Command(bare, { args: [WC], stdout: "piped", stderr: "piped" })
        .outputSync();
      assertEquals(denied.code, 1, "no filesystem, and the application says so");
      assertEquals(
        new TextDecoder().decode(denied.stderr).includes("not granted"),
        true,
        new TextDecoder().decode(denied.stderr),
      );
      // The shebang is exactly the grants, so a program granted nothing asks for nothing.
      // That is only possible because the worker comes from a blob URL: spawning the file
      // itself needs --allow-read, which used to sit in every shebang and read as a
      // filesystem grant to anyone auditing it.
      assertEquals(
        (await Deno.readTextFile(bare)).split("\n")[0],
        "#!/usr/bin/env -S deno run",
        "no capabilities, no permissions",
      );
    } finally {
      await Deno.remove(bare);
    }
  } finally {
    await Deno.remove(out);
  }
});

Deno.test("the same application builds for Node and agrees with the Deno build", async () => {
  // The bridge, the opcodes and the capability structs are shared; only a dozen closures
  // and the thread API differ. This is what checks that claim rather than asserting it.
  const { buildApp } = await import("../build.ts");
  const denoOut = await Deno.makeTempFile({ prefix: "wac-deno-" });
  const nodeOut = await Deno.makeTempFile({ prefix: "wac-node-" });
  try {
    await buildApp(WC, denoOut, { read: true }, "deno");
    await buildApp(WC, nodeOut, { read: true }, "node");

    assertEquals(
      (await Deno.readTextFile(nodeOut)).split("\n")[0],
      "#!/usr/bin/env node",
      "Node has no permission system, so its shebang states nothing",
    );

    const run = (path: string, cmd?: string) => {
      const r = cmd
        ? new Deno.Command(cmd, { args: [path, WC], stdout: "piped", stderr: "piped" }).outputSync()
        : new Deno.Command(path, { args: [WC], stdout: "piped", stderr: "piped" }).outputSync();
      return {
        code: r.code,
        out: new TextDecoder().decode(r.stdout).trim(),
        err: new TextDecoder().decode(r.stderr).trim(),
      };
    };

    const d = run(denoOut);
    const n = run(nodeOut, "node");
    assertEquals(d.code, 0, d.err);
    assertEquals(n.code, 0, n.err);
    assertEquals(n.out, d.out, "byte for byte, the same answer from both runtimes");

    // And the capability boundary holds on Node, where it is the *only* boundary — there
    // is no process-level permission behind it.
    const bare = await Deno.makeTempFile({ prefix: "wac-node-nofs-" });
    try {
      await buildApp(WC, bare, {}, "node");
      const denied = new Deno.Command("node", { args: [bare, WC], stdout: "piped", stderr: "piped" })
        .outputSync();
      assertEquals(denied.code, 1);
      assertEquals(
        new TextDecoder().decode(denied.stderr).includes("not granted"),
        true,
        new TextDecoder().decode(denied.stderr),
      );
    } finally {
      await Deno.remove(bare);
    }
  } finally {
    await Deno.remove(denoOut);
    await Deno.remove(nodeOut);
  }
});

// ── Filters: stdin, byte output, stat, readDir ────────────────────────────────

const HEXDUMP = "packages/platform/example/hexdump.wac";

/** Build once, then run with the given stdin and arguments. */
async function runFilter(
  entry: string,
  args: string[],
  stdin: Uint8Array,
  grants: Grants = {},
): Promise<{ code: number; out: Uint8Array; err: string }> {
  const built = await Deno.makeTempFile({ prefix: "wac-filter-" });
  try {
    await buildApp(entry, built, grants);
    const child = new Deno.Command(built, {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const w = child.stdin.getWriter();
    await w.write(stdin);
    await w.close();
    const r = await child.output();
    return { code: r.code, out: r.stdout, err: new TextDecoder().decode(r.stderr) };
  } finally {
    await Deno.remove(built);
  }
}

Deno.test("a program can be a filter: stdin in, exact bytes out", async () => {
  // The gap that mattered most. `log` appends a newline and assumes text, so nothing
  // could emit binary — every compressor and encoder was a file-to-file tool and could
  // not go in a pipe. `readStdin` and `write` are what change that, and neither needs a
  // grant: what the user pipes in and what the program prints are the user's own doing.
  const input = new TextEncoder().encode("hello, wac");
  const r = await runFilter(HEXDUMP, [], input);
  assertEquals(r.code, 0, r.err);
  const text = new TextDecoder().decode(r.out);
  assertEquals(text.startsWith("00000000  68 65 6c 6c 6f 2c 20 77 61 63"), true, text);
  // Exactly one line, ending in a newline — `write` added nothing of its own.
  assertEquals(text.split("\n").length, 2, JSON.stringify(text));

  // Bytes, not text: 0x00 and 0xFF survive, which a string-shaped output would mangle.
  const binary = await runFilter(HEXDUMP, [], new Uint8Array([0, 255, 128]));
  assertEquals(new TextDecoder().decode(binary.out).includes("00 ff 80"), true);
});

Deno.test("wc reads standard input when given no file", async () => {
  const text = await Deno.readTextFile(WC);
  const r = await runFilter(WC, [], new TextEncoder().encode(text));
  assertEquals(r.code, 0, r.err);
  const [lines, words, bytes] = new TextDecoder().decode(r.out).trim().split(/\s+/);
  assertEquals(Number(bytes), new TextEncoder().encode(text).length);
  assertEquals(Number(lines), text.split("\n").length - 1);
  assertEquals(Number(words), text.split(/\s+/).filter((w) => w.length > 0).length);
});

Deno.test("stat and readDir reach the application, and are gated", async () => {
  // A directory of this test's own making, listed against what was put in it. It used to list
  // `packages/platform/src` and expect exactly "platform.wac", which meant adding a second file to this
  // package — `stream.wac` — failed a test about `readDir`. A fixture that changes when the source tree
  // changes is testing the source tree.
  const dir = await Deno.makeTempDir({ prefix: "wac-readdir-" });
  try {
    await Deno.writeTextFile(`${dir}/one.txt`, "1");
    await Deno.writeTextFile(`${dir}/two.txt`, "2");
    await Deno.mkdir(`${dir}/sub`);
    const listed = await runFilter(HEXDUMP, [dir], new Uint8Array(), { read: true });
    assertEquals(listed.code, 0, listed.err);
    assertEquals(new TextDecoder().decode(listed.out).trim().split("\n").sort().join(" "),
      "one.txt sub two.txt");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }

  // Without the grant, `stat` reports "does not exist" rather than throwing: an
  // application cannot tell a withheld capability from an absent file, which is the
  // right amount for it to know.
  const denied = await runFilter(HEXDUMP, ["packages/platform/src"], new Uint8Array());
  assertEquals(denied.code, 1);
  assertEquals(denied.err.includes("not found"), true, denied.err);
});
const BOX = "packages/box/src/box.wac";


/**
 * `assertEquals` above is `!==`, so two byte arrays are never equal to it. This says where
 * they diverge, which for a compressor is the only useful thing to be told.
 */
function assertSameBytes(got: Uint8Array, want: Uint8Array, msg: string): void {
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i] !== want[i]) {
      throw new Error(
        `${msg}\n  first difference at byte ${i}: got ${got[i]}, want ${want[i]}` +
          ` (lengths ${got.length} and ${want.length})`,
      );
    }
  }
}


Deno.test("the bridge chunks in both directions", async () => {
  // It only chunked responses. A `readFile` of ten megabytes worked and a `writeFile` of
  // two threw `request of 2000000 bytes exceeds the 1048576-byte buffer` — so every applet
  // whose output is its input died above a megabyte, and `cp` turned that into "cannot
  // write", blaming the destination for a limit in the transport.
  //
  // Sizes here straddle the 1MB buffer deliberately: just under, just over, and several
  // multiples, plus an exact multiple where the last chunk is empty.
  const built = await Deno.makeTempFile({ prefix: "wac-big-" });
  const src = await Deno.makeTempFile({ prefix: "wac-big-src-" });
  const dst = await Deno.makeTempFile({ prefix: "wac-big-dst-" });
  try {
    await buildApp(BOX, built, { read: true, write: true });
    const MB = 1 << 20;
    for (const size of [MB - 1, MB, MB + 1, 3 * MB, 2 * MB]) {
      // Not random: a pattern that a truncation or a doubled chunk would visibly break.
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) data[i] = (i * 31 + (i >> 13)) & 0xFF;
      await Deno.writeFile(src, data);

      // Out through `write`: the whole file crosses as the request payload.
      const cat = new Deno.Command(built, {
        args: ["cat", src], stdout: "piped", stderr: "piped",
      }).outputSync();
      assertEquals(cat.code, 0, new TextDecoder().decode(cat.stderr));
      assertSameBytes(cat.stdout, data, `cat at ${size} bytes`);

      // And through `writeFile`, which is where `cp` was failing.
      const cp = new Deno.Command(built, { args: ["cp", src, dst], stderr: "piped" }).outputSync();
      assertEquals(cp.code, 0, `cp at ${size}: ${new TextDecoder().decode(cp.stderr)}`);
      assertSameBytes(await Deno.readFile(dst), data, `cp at ${size} bytes`);
    }

    // Both directions at once, through a compressor, so the request and response halves
    // are exercised against each other rather than only against a fixture.
    const data = await Deno.readFile(src);
    const gz = new Deno.Command(built, { args: ["gzip", src], stdout: "piped" }).outputSync();
    const back = new Deno.Command(built, {
      args: ["gunzip"], stdin: "piped", stdout: "piped",
    }).spawn();
    const w = back.stdin.getWriter();
    w.write(gz.stdout).then(() => w.close());
    assertSameBytes((await back.output()).stdout, data, "gzip and back at 2MB");
  } finally {
    for (const f of [built, src, dst]) await Deno.remove(f);
  }
});
