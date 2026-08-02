// The world, end to end: a wac application with no TypeScript of its own, run on a
// worker, calling capabilities the host answers asynchronously.
//
// The central claim is that an `await` on the main thread is invisible from wac. These
// tests are what makes that a measurement — `readFile` really is `await Deno.readFile`,
// and the wac side really does call it as a function.

import { runApp } from "../host/launch.ts";
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

/** Collect what the application logged instead of letting it reach the console. */
function collector() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l: string) => out.push(l), warn: (l: string) => err.push(l) };
}

Deno.test("an application written entirely in wac runs, and agrees with wc", async () => {
  const c = collector();
  const code = await runApp(WC, { args: [WC], fs: { read: true }, log: c.log, warn: c.warn });
  assertEquals(code, 0);
  // Checked against the system `wc` when this was written: 76 455 2588.
  const [lines, words, bytes] = c.out[0].split(/\s+/);
  const text = await Deno.readTextFile(WC);
  assertEquals(Number(bytes), new TextEncoder().encode(text).length, "bytes");
  assertEquals(Number(lines), text.split("\n").length - 1, "lines");
  assertEquals(Number(words), text.split(/\s+/).filter((w) => w.length > 0).length, "words");
});

Deno.test("a capability the host withholds is a failure the application can report", async () => {
  // No `fs` option at all, so the world has no filesystem. The application gets an
  // ordinary failed FileResult rather than an exception, and decides what to do.
  const c = collector();
  const code = await runApp(WC, { args: [WC], log: c.log, warn: c.warn });
  assertEquals(code, 1, "the application reported failure");
  assertEquals(c.err.length, 1);
  assertEquals(c.err[0].includes("not granted"), true, `got: ${c.err[0]}`);
  assertEquals(c.out.length, 0, "and printed no counts");
});

Deno.test("a missing file reaches the application as its host's message", async () => {
  const c = collector();
  const code = await runApp(WC, { args: ["no/such/file"], fs: { read: true }, log: c.log, warn: c.warn });
  assertEquals(code, 1);
  assertEquals(c.err[0].includes("no/such/file"), true, `got: ${c.err[0]}`);
});

Deno.test("an application with no arguments says how to be used", async () => {
  const c = collector();
  assertEquals(await runApp(WC, { args: [], log: c.log, warn: c.warn }), 2);
  assertEquals(c.err[0], "usage: wc <file>");
});

Deno.test("env distinguishes unset from empty", async () => {
  const c = collector();
  await runApp(WC, {
    args: [WC], fs: { read: true }, log: c.log, warn: c.warn,
    env: (n) => (n === "WC_VERBOSE" ? "" : undefined),
  });
  // An empty value is still *set*, so the timing line appears. A nullable string is what
  // makes the difference expressible at all — it is why `string?` had to cross.
  assertEquals(c.out.length, 2, `expected the timing line, got ${JSON.stringify(c.out)}`);
  assertEquals(c.out[1].startsWith("counted in "), true);

  const c2 = collector();
  await runApp(WC, { args: [WC], fs: { read: true }, log: c2.log, warn: c2.warn });
  assertEquals(c2.out.length, 1, "unset means absent");
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
