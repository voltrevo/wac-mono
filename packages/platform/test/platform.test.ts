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
  const listed = await runFilter(HEXDUMP, ["packages/platform/src"], new Uint8Array(), {
    read: true,
  });
  assertEquals(listed.code, 0, listed.err);
  assertEquals(new TextDecoder().decode(listed.out).trim(), "platform.wac");

  // Without the grant, `stat` reports "does not exist" rather than throwing: an
  // application cannot tell a withheld capability from an absent file, which is the
  // right amount for it to know.
  const denied = await runFilter(HEXDUMP, ["packages/platform/src"], new Uint8Array());
  assertEquals(denied.code, 1);
  assertEquals(denied.err.includes("not found"), true, denied.err);
});

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

// ── box: many applets in one program ──────────────────────────────────────────

const BOX = "packages/platform/example/box/box.wac";

Deno.test("box's applets agree with the system tools they imitate", async () => {
  // The widest test of the world so far, and a differential one: every applet here is
  // compared against the real utility rather than against my idea of it. `sha256sum` and
  // `base64` go through this repo's own crypto and codec packages, so this is also the
  // first application to compose several packages at once.
  const built = await Deno.makeTempFile({ prefix: "wac-box-" });
  const input = "alpha beta\ngamma\ndelta epsilon zeta\n";
  const fixture = await Deno.makeTempFile({ prefix: "wac-box-in-" });
  try {
    await buildApp(BOX, built, { read: true });
    await Deno.writeTextFile(fixture, input);

    const box = (args: string[]) => {
      const r = new Deno.Command(built, { args, stdout: "piped", stderr: "piped" }).outputSync();
      return { code: r.code, out: new TextDecoder().decode(r.stdout) };
    };
    const sys = (cmd: string, args: string[]) => {
      const r = new Deno.Command(cmd, { args, stdout: "piped", stderr: "null" }).outputSync();
      return new TextDecoder().decode(r.stdout);
    };

    // Byte-for-byte against the real thing, where the real thing exists here.
    for (const [applet, cmd] of [["cat", "cat"], ["rev", "rev"], ["nl", "nl"], ["base64", "base64"]]) {
      assertEquals(box([applet, fixture]).out, sys(cmd, [fixture]), `${applet} differs`);
    }
    assertEquals(
      box(["sha256sum", fixture]).out.split(" ")[0],
      sys("sha256sum", [fixture]).split(" ")[0],
      "sha256sum differs",
    );

    // `wc` prints its columns without padding, so compare the numbers rather than the text.
    assertEquals(
      box(["wc", fixture]).out.trim().split(/\s+/).slice(0, 3).join(" "),
      sys("wc", [fixture]).trim().split(/\s+/).slice(0, 3).join(" "),
      "wc counts differ",
    );

    // Flags, which every applet gets from one shared parser.
    for (const [args, cmd] of [
      [["sort"], ["sort"]], [["sort", "-r"], ["sort", "-r"]], [["sort", "-u"], ["sort", "-u"]],
      [["tac"], ["tac"]],
    ] as [string[], string[]][]) {
      assertEquals(
        box([...args, fixture]).out,
        sys(cmd[0], [...cmd.slice(1), fixture]),
        `${args.join(" ")} differs`,
      );
    }
    assertEquals(box(["head", "-3", fixture]).out, sys("head", ["-3", fixture]), "head -N");
    assertEquals(box(["tail", "-n", "2", fixture]).out, sys("tail", ["-n", "2", fixture]), "tail -n N");
    assertEquals(box(["wc", "-l", fixture]).out.trim(), sys("wc", ["-l", fixture]).trim().split(/\s+/)[0]);
    assertEquals(
      box(["sha512sum", fixture]).out.split(" ")[0],
      sys("sha512sum", [fixture]).split(" ")[0],
      "sha512sum differs",
    );
    assertEquals(box(["base32", fixture]).out, sys("base32", [fixture]), "base32 differs");

    // grep, which brings the regex package in. Every flag against the real thing.
    for (const args of [["grep", "an"], ["grep", "-i", "AN"], ["grep", "-v", "an"],
                        ["grep", "-n", "an"], ["grep", "-c", "an"]]) {
      assertEquals(
        box([...args, fixture]).out,
        sys("grep", [...args.slice(1), fixture]),
        `${args.join(" ")} differs`,
      );
    }
    assertEquals(box(["grep", "zzznope", fixture]).code, 1, "no match exits 1, as grep does");
    assertEquals(box(["grep", "[", fixture]).code, 2, "a bad pattern is a usage error");

    assertEquals(box(["basename", "a/b/c.txt"]).out.trim(), "c.txt");
    assertEquals(box(["dirname", "a/b/c.txt"]).out.trim(), "a/b");
    assertEquals(box(["echo", "hello", "wac"]).out.trim(), "hello wac");
    assertEquals(box(["seq", "3"]).out.trim().split("\n").join(","), "1,2,3");
    assertEquals(box(["true"]).code, 0);
    assertEquals(box(["false"]).code, 1);
    assertEquals(box(["nope"]).code, 2, "an unknown applet is a usage error");

    // The first applets that recurse, against the real tools over a nested tree.
    assertEquals(
      box(["find", "packages/platform/src"]).out.trim().split("\n").sort().join("\n"),
      sys("find", ["packages/platform/src"]).trim().split("\n").sort().join("\n"),
      "find differs",
    );
    assertEquals(
      box(["du", "packages/platform/src"]).out.split("\t")[0],
      sys("du", ["-sb", "packages/platform/src"]).split("\t")[0],
      "du differs from du -sb",
    );

    // head and tail against a file with more lines than they take.
    const many = await Deno.makeTempFile();
    try {
      await Deno.writeTextFile(many, Array.from({ length: 15 }, (_, i) => i + 1).join("\n") + "\n");
      assertEquals(box(["head", many]).out, sys("head", ["-10", many]), "head differs");
      assertEquals(box(["tail", many]).out, sys("tail", ["-10", many]), "tail differs");
    } finally {
      await Deno.remove(many);
    }
  } finally {
    await Deno.remove(built);
    await Deno.remove(fixture);
  }
});

Deno.test("box works as a filter, and its applets need only what they use", async () => {
  const input = new TextEncoder().encode("one two\nthree\n");
  // No grants at all: reading standard input is not a capability, so a pipeline works
  // even where the filesystem was withheld.
  const piped = await runFilter(BOX, ["wc"], input);
  assertEquals(piped.code, 0, piped.err);
  assertEquals(new TextDecoder().decode(piped.out).trim(), "2 3 14");

  const hashed = await runFilter(BOX, ["sha256sum"], input);
  assertEquals(new TextDecoder().decode(hashed.out).trim().endsWith("  -"), true, "stdin is '-'");

  // But a file still needs the grant, and says so.
  const denied = await runFilter(BOX, ["cat", "README.md"], new Uint8Array());
  assertEquals(denied.code, 1);
  assertEquals(denied.err.includes("not granted"), true, denied.err);
});

Deno.test("box's write-path applets: cp and tee", async () => {
  // The first applets in `box` that write. `cp` needs no capability the world did not
  // already have — it is `readFile` and `writeFile` — and `tee` is the first with two
  // destinations at once.
  const built = await Deno.makeTempFile({ prefix: "wac-box-w-" });
  const dst = await Deno.makeTempFile({ prefix: "wac-box-dst-" });
  try {
    await buildApp(BOX, built, { read: true, write: true });
    const src = "packages/platform/example/box/box.wac";

    const cp = new Deno.Command(built, { args: ["cp", src, dst], stderr: "piped" }).outputSync();
    assertEquals(cp.code, 0, new TextDecoder().decode(cp.stderr));
    assertEquals(await Deno.readTextFile(dst), await Deno.readTextFile(src), "cp copied it");

    const child = new Deno.Command(built, {
      args: ["tee", dst],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode("through\n"));
    await w.close();
    const r = await child.output();
    assertEquals(r.code, 0, new TextDecoder().decode(r.stderr));
    assertEquals(new TextDecoder().decode(r.stdout), "through\n", "tee wrote to stdout");
    assertEquals(await Deno.readTextFile(dst), "through\n", "and to the file");
  } finally {
    await Deno.remove(built);
    await Deno.remove(dst);
  }
});

Deno.test("box's applets compose in a pipeline", async () => {
  // Three wac programs in a row, which is the thing a file-to-file tool could never do.
  const built = await Deno.makeTempFile({ prefix: "wac-box-p-" });
  try {
    await buildApp(BOX, built, { read: true });
    const run = (args: string[], input: string) => {
      const child = new Deno.Command(built, {
        args, stdin: "piped", stdout: "piped", stderr: "piped",
      }).spawn();
      const w = child.stdin.getWriter();
      w.write(new TextEncoder().encode(input)).then(() => w.close());
      return child.output().then((r) => new TextDecoder().decode(r.stdout));
    };
    const sorted = await run(["sort", "-u"], "b\na\nb\nc\na\n");
    assertEquals(sorted, "a\nb\nc\n");
    assertEquals(await run(["wc", "-l"], sorted), "3\n");
    assertEquals(await run(["tac"], sorted), "c\nb\na\n");
  } finally {
    await Deno.remove(built);
  }
});

Deno.test("box's text applets agree with the system tools they imitate", async () => {
  // The second differential batch: `cut`, `tr`, `fold` and `strings`. Everything is checked
  // against the real tool rather than against my idea of it, as the first batch is.
  const built = await Deno.makeTempFile({ prefix: "wac-box-t-" });
  const fixture = await Deno.makeTempFile({ prefix: "wac-box-tin-" });
  try {
    await buildApp(BOX, built, { read: true });
    await Deno.writeTextFile(fixture, "a,b,c\nd,e,f\nnodelim\n,leading,\n");

    const box = (args: string[], input = "") => {
      const child = new Deno.Command(built, {
        args, stdin: "piped", stdout: "piped", stderr: "piped",
      }).spawn();
      const w = child.stdin.getWriter();
      w.write(new TextEncoder().encode(input)).then(() => w.close());
      return child.output().then((o) => new TextDecoder().decode(o.stdout));
    };
    const sys = (cmd: string, args: string[], input = "") => {
      const child = new Deno.Command(cmd, {
        args, stdin: "piped", stdout: "piped", stderr: "null",
      }).spawn();
      const w = child.stdin.getWriter();
      w.write(new TextEncoder().encode(input)).then(() => w.close());
      return child.output().then((o) => new TextDecoder().decode(o.stdout));
    };

    // cut: a field, a chosen delimiter, and a line that has none — which `cut` passes
    // through whole, on the reasoning that a line with no fields is one field.
    for (const f of ["1", "2", "3", "9"]) {
      assertEquals(
        await box(["cut", "-d,", `-f${f}`, fixture]),
        await sys("cut", ["-d,", `-f${f}`, fixture]),
        `cut -f${f} differs`,
      );
    }
    assertEquals(
      await box(["cut", "-f2", fixture]),
      await sys("cut", ["-f2", fixture]),
      "cut with the default tab delimiter differs",
    );
    // A flag's value must be attached. The separated spelling would be indistinguishable
    // from a filename once parsed, so it is refused rather than silently misread.
    const bare = new Deno.Command(built, {
      args: ["cut", "-d", ",", "-f", "2", fixture],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    assertEquals(bare.code, 2, "a detached flag value should be a usage error");
    assertEquals(
      new TextDecoder().decode(bare.stderr).includes("-f<n>"),
      true,
      "and should say how to spell it",
    );

    const text = await Deno.readTextFile("README.md");
    for (const sets of [["a-z", "A-Z"], ["aeiou", "."], ["abc", "x"], ["A-Za-z", "N-ZA-Mn-za-m"]]) {
      assertEquals(
        await box(["tr", ...sets], text),
        await sys("tr", sets, text),
        `tr ${sets.join(" ")} differs`,
      );
    }

    for (const w of ["10", "20", "80"]) {
      assertEquals(
        await box(["fold", `-${w}`, fixture]),
        await sys("fold", [`-w${w}`, fixture]),
        `fold -${w} differs`,
      );
    }

    // `strings` on a binary: the one applet whose input is deliberately not text.
    for (const n of ["4", "8"]) {
      assertEquals(
        await box(["strings", `-${n}`, "/bin/true"]),
        await sys("strings", [`-n${n}`, "/bin/true"]),
        `strings -${n} differs`,
      );
    }
  } finally {
    await Deno.remove(built);
    await Deno.remove(fixture);
  }
});

Deno.test("box's package-backed applets: gzip, gunzip, crc32, date, urlencode", async () => {
  // These are the point of `box`: each is a few lines over a package written in this repo
  // for TypeScript bindings, reused unchanged as the inside of a program. The compression
  // ones are checked against the system `gzip` in *both* directions, so neither side can be
  // wrong in a way the other cancels out.
  const built = await Deno.makeTempFile({ prefix: "wac-box-g-" });
  try {
    await buildApp(BOX, built, { read: true });
    const raw = await Deno.readFile("README.md");

    const run = (args: string[], input: Uint8Array) => {
      const child = new Deno.Command(built, {
        args, stdin: "piped", stdout: "piped", stderr: "piped",
      }).spawn();
      const w = child.stdin.getWriter();
      w.write(input).then(() => w.close());
      return child.output();
    };
    const sysRun = (cmd: string, args: string[], input: Uint8Array) => {
      const child = new Deno.Command(cmd, {
        args, stdin: "piped", stdout: "piped", stderr: "null",
      }).spawn();
      const w = child.stdin.getWriter();
      w.write(input).then(() => w.close());
      return child.output();
    };

    const squeezed = (await run(["gzip"], raw)).stdout;
    assertEquals(squeezed.length < raw.length, true, "gzip did not compress");
    assertSameBytes((await run(["gunzip"], squeezed)).stdout, raw, "box could not read its own gzip");
    assertSameBytes(
      (await sysRun("gunzip", [], squeezed)).stdout,
      raw,
      "the system gzip could not read box's",
    );
    assertSameBytes(
      (await run(["gunzip"], (await sysRun("gzip", ["-c"], raw)).stdout)).stdout,
      raw,
      "box could not read the system gzip's",
    );

    // crc32 against the checksum gzip itself carries, computed independently here.
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    let crc = 0xFFFFFFFF;
    for (const b of raw) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    const expect = ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, "0");
    assertEquals(new TextDecoder().decode((await run(["crc32"], raw)).stdout).trim(), `${expect}  -`);

    // `date` is the clock capability with a package on top; it must be RFC 3339 and now.
    const now = new TextDecoder().decode((await run(["date"], new Uint8Array())).stdout).trim();
    const parsed = Date.parse(now);
    assertEquals(Number.isNaN(parsed), false, `not a date: ${now}`);
    assertEquals(Math.abs(parsed - Date.now()) < 60_000, true, `not now: ${now}`);

    // Percent-encoding round-trips, including bytes that are not ASCII at all.
    const enc = new TextEncoder();
    for (const s of ["a b/c?d=e&f#g", "ünïcode ✓", "plain", "%already%20encoded"]) {
      const encoded = (await run(["urlencode"], enc.encode(s + "\n"))).stdout;
      assertEquals(
        new TextDecoder().decode(encoded).includes(" "),
        false,
        "a space survived encoding",
      );
      assertEquals(
        new TextDecoder().decode((await run(["urldecode"], encoded)).stdout),
        s + "\n",
        `${s} did not round-trip`,
      );
    }
  } finally {
    await Deno.remove(built);
  }
});

Deno.test("box's mutation tier: mkdir, rm, rmdir, mv, touch", async () => {
  // `writeFile` was the only mutation the world had, which meant an application could
  // create a file but never remove or move one — so it could not write safely either.
  // These three ops are what `cp` needs to write beside its target and rename into place.
  const built = await Deno.makeTempFile({ prefix: "wac-box-m-" });
  const root = await Deno.makeTempDir({ prefix: "wac-box-fs-" });
  try {
    await buildApp(BOX, built, { read: true, write: true });
    const box = (args: string[]) => {
      const r = new Deno.Command(built, { args, stdout: "piped", stderr: "piped" }).outputSync();
      return { code: r.code, err: new TextDecoder().decode(r.stderr) };
    };
    const exists = async (p: string) => {
      try {
        await Deno.stat(p);
        return true;
      } catch {
        return false;
      }
    };

    const deep = `${root}/a/b/c`;
    assertEquals(box(["mkdir", "-p", deep]).code, 0);
    assertEquals(await exists(deep), true, "mkdir -p made the parents");
    // Without -p a missing parent is an error, which is the difference between them.
    assertEquals(box(["mkdir", `${root}/x/y`]).code, 1, "mkdir without -p needs the parent");

    assertEquals(box(["touch", `${deep}/f`]).code, 0);
    assertEquals((await Deno.stat(`${deep}/f`)).size, 0, "touch made it empty");
    await Deno.writeTextFile(`${deep}/f`, "kept");
    assertEquals(box(["touch", `${deep}/f`]).code, 0);
    assertEquals(await Deno.readTextFile(`${deep}/f`), "kept", "touch left an existing file alone");

    assertEquals(box(["mv", `${deep}/f`, `${root}/moved`]).code, 0);
    assertEquals(await exists(`${deep}/f`), false, "mv left nothing behind");
    assertEquals(await Deno.readTextFile(`${root}/moved`), "kept", "mv kept the contents");

    // `rmdir` is never recursive; that distinction is the reason it is its own command.
    await Deno.writeTextFile(`${deep}/g`, "x");
    assertEquals(box(["rmdir", deep]).code, 1, "rmdir refuses a non-empty directory");
    assertEquals(box(["rm", `${deep}/g`]).code, 0);
    assertEquals(box(["rmdir", deep]).code, 0, "and takes an empty one");

    // Absence is an error unless you say it is not, as `rm -f` says.
    assertEquals(box(["rm", `${root}/never`]).code, 1);
    assertEquals(box(["rm", "-f", `${root}/never`]).code, 0);
    assertEquals(box(["rm", `${root}/a`]).code, 1, "rm needs -r for a directory");
    assertEquals(box(["rm", "-r", `${root}/a`]).code, 0);
    assertEquals(await exists(`${root}/a`), false);

    // The point of the tier: `cp` writes beside its target and renames, so the destination
    // is never seen half-written and no temporary name survives a successful copy.
    assertEquals(box(["cp", "README.md", `${root}/copy`]).code, 0);
    assertEquals(
      await Deno.readTextFile(`${root}/copy`),
      await Deno.readTextFile("README.md"),
      "cp copied it",
    );
    const left: string[] = [];
    for await (const e of Deno.readDir(root)) left.push(e.name);
    assertEquals(left.sort().join(","), "copy,moved", `a temporary file survived: ${left}`);

    // And without the write grant none of it happens, whatever the arguments say.
    const readOnly = await Deno.makeTempFile({ prefix: "wac-box-ro-" });
    try {
      await buildApp(BOX, readOnly, { read: true });
      const r = new Deno.Command(readOnly, {
        args: ["mkdir", `${root}/denied`],
        stdout: "piped",
        stderr: "piped",
      }).outputSync();
      assertEquals(r.code, 1, "mkdir without the grant should fail");
      assertEquals(await exists(`${root}/denied`), false, "and should make nothing");
    } finally {
      await Deno.remove(readOnly);
    }
  } finally {
    await Deno.remove(built);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bin/: one applet alone states only the grants it needs", async () => {
  // The README has been claiming that a multicall binary costs you the permission story
  // and that built separately each applet would state its own. This measures it rather
  // than asserting it: `wc` and `sha256sum` come out with an empty shebang, and a `wc`
  // built that way cannot open a file even when told to.
  const cases: Array<{ name: string; grants: Grants; shebang: string }> = [
    { name: "wc", grants: {}, shebang: "#!/usr/bin/env -S deno run" },
    { name: "sha256sum", grants: {}, shebang: "#!/usr/bin/env -S deno run" },
    { name: "grep", grants: { read: true }, shebang: "#!/usr/bin/env -S deno run --allow-read" },
    {
      name: "cp",
      grants: { read: true, write: true },
      shebang: "#!/usr/bin/env -S deno run --allow-read --allow-write",
    },
  ];
  const built: string[] = [];
  try {
    for (const c of cases) {
      const out = await Deno.makeTempFile({ prefix: `wac-bin-${c.name}-` });
      built.push(out);
      await buildApp(`packages/platform/example/box/bin/${c.name}.wac`, out, c.grants);
      const first = (await Deno.readTextFile(out)).split("\n")[0];
      assertEquals(first, c.shebang, `${c.name}'s shebang`);
    }

    const [wc, sha, grep, cp] = built;
    const pipe = (path: string, args: string[], input: string) => {
      const child = new Deno.Command(path, {
        args, stdin: "piped", stdout: "piped", stderr: "piped",
      }).spawn();
      const w = child.stdin.getWriter();
      w.write(new TextEncoder().encode(input)).then(() => w.close());
      return child.output();
    };
    const dec = new TextDecoder();

    // The applet is the same code, so it must behave the same with no `box` in front.
    const text = "alpha beta\ngamma\n";
    assertEquals(dec.decode((await pipe(wc, [], text)).stdout).trim(), "2 3 17");
    assertEquals(dec.decode((await pipe(wc, ["-l"], text)).stdout).trim(), "2", "flags still parse");
    assertEquals(
      dec.decode((await pipe(sha, [], text)).stdout).trim().endsWith("  -"),
      true,
      "stdin is still '-'",
    );
    assertEquals(dec.decode((await pipe(grep, ["-c", "beta"], text)).stdout).trim(), "1");

    // And a program with no grants cannot be talked into a read, whatever it is passed.
    const denied = await pipe(wc, ["README.md"], "");
    assertEquals(denied.code, 1);
    assertEquals(dec.decode(denied.stderr).includes("not granted"), true);
    // It names itself, not `box` — the entry point in `bin/` passes the name, because a
    // program in this model is never handed its own argv[0].
    assertEquals(dec.decode(denied.stderr).startsWith("wc: "), true, dec.decode(denied.stderr));

    // The one with grants does the real thing.
    const dst = await Deno.makeTempFile({ prefix: "wac-bin-dst-" });
    try {
      const r = new Deno.Command(cp, { args: ["README.md", dst], stderr: "piped" }).outputSync();
      assertEquals(r.code, 0, dec.decode(r.stderr));
      assertEquals(await Deno.readTextFile(dst), await Deno.readTextFile("README.md"));
    } finally {
      await Deno.remove(dst);
    }

    // The size of what you gave up: `box` carries every applet and every grant.
    const alone = (await Deno.stat(wc)).size;
    const all = await Deno.makeTempFile({ prefix: "wac-bin-box-" });
    built.push(all);
    await buildApp(BOX, all, { read: true, write: true });
    assertEquals(alone * 2 < (await Deno.stat(all)).size, true, "box should be much larger");
  } finally {
    for (const b of built) await Deno.remove(b);
  }
});
