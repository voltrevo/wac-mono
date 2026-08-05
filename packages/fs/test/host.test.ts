// The in-memory filesystem against the host's, operation for operation.
//
// The host is the oracle: whatever Deno's filesystem does to a sequence of writes, listings, renames and
// removals is what a filesystem *is*, and a memory implementation that disagrees is wrong even when its
// own tests pass. So `example/ops.wac` runs one script two ways — `ops mem` and `ops host <dir>` — and
// this compares the two transcripts.
//
// The scripts are shared bytes and nothing else: one process holds the tree in memory, the other in
// `/tmp`, and neither knows about the other. That is the same arrangement `packages/wacc` uses to compare
// two parsers, and it is why a divergence here means something.

import { buildApp } from "../../platform/build.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const built = await Deno.makeTempFile({ prefix: "wac-fs-ops-" });
globalThis.addEventListener("unload", () => {
  try {
    Deno.removeSync(built);
  } catch {
    // Already gone. Nothing to report on the way out.
  }
});
await buildApp("packages/fs/example/ops.wac", built, { read: true, write: true });

/** Run a script against one backing and return its transcript. */
async function run(args: string[], script: string): Promise<string> {
  const child = new Deno.Command(built, { args, stdin: "piped", stdout: "piped", stderr: "piped" })
    .spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(script));
  await w.close();
  const out = await child.output();
  const err = new TextDecoder().decode(out.stderr);
  if (err.trim().length > 0) throw new Error(`ops ${args.join(" ")}: ${err}`);
  return new TextDecoder().decode(out.stdout);
}

/**
 * The same script in memory and on a real disk.
 *
 * The host run works under a temp directory, so every path in a script is relative-looking but absolute
 * once the prefix is added — which is what `ops` does with its second argument. The memory run gets an
 * empty prefix, so `/a` really is `/a` in a filesystem that has nothing else in it.
 */
async function bothWays(name: string, script: string): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "wac-fs-host-" });
  try {
    const inMemory = await run(["mem"], script);
    const onHost = await run(["host", dir], script);
    // The host's transcript names the temp directory nowhere — the answers are categories, sizes and
    // listings — so the two are comparable directly.
    assertEquals(inMemory, onHost, `${name}\n--- script ---\n${script}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a file written reads back, the same way on both", async () => {
  await bothWays("files", [
    "stat /a",
    "write /a hello",
    "stat /a",
    "read /a",
    "write /a bye",
    "read /a",
    "stat /a",
  ].join("\n"));
});

Deno.test("directories, and the three faults that tell rm -f from rm", async () => {
  await bothWays("directories", [
    "mkdir /d",
    "mkdir /d",
    "stat /d",
    "write /d/f x",
    "rm /d",
    "rm /d/f",
    "rm /d",
    "rm /d",
    "rm /gone",
    "mkdir /x/y",
    "write /x/y z",
  ].join("\n"));
});

Deno.test("mkdir -p and rm -r", async () => {
  await bothWays("flags", [
    "mkdirp /a/b/c",
    "stat /a/b/c",
    "mkdirp /a/b/c",
    "write /a/b/c/f one",
    "rm /a",
    "rmr /a",
    "stat /a",
    "rmr /a",
  ].join("\n"));
});

Deno.test("a listing is the same set, in the same order", async () => {
  await bothWays("listing", [
    "write /b one",
    "write /a two",
    "mkdir /c",
    "write /c/inside three",
    "ls /",
    "ls /c",
    "ls /a",
    "ls /nope",
    "rm /a",
    "ls /",
  ].join("\n"));
});

Deno.test("rename moves a name, over an existing one if it has to", async () => {
  await bothWays("rename", [
    "mkdir /d",
    "write /a one",
    "mv /a /d/b",
    "stat /a",
    "read /d/b",
    "write /c two",
    "mv /d/b /c",
    "read /c",
    "mv /gone /x",
    "mv /c /nodir/x",
  ].join("\n"));
});

Deno.test("writing over a directory, and reading one", async () => {
  // Both refuse, and the *category* is what has to match: the messages are the host's own words.
  await bothWays("kinds", [
    "mkdir /d",
    "read /d",
    "write /d no",
    "stat /d",
  ].join("\n"));
});
