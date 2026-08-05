// A session whose filesystem is its own.
//
// wac-mono 0067, and the payoff for threading the filesystem through the shell as a *value*: `wacsh` is a
// shell on the host, `sealed` is the same shell handed `Fs.inMemory()`, and the difference is one line at
// the top of the program.
//
// The strongest part of this is not what the tests assert but how the binary is built: **no filesystem
// grants at all**. `buildApp(..., {})` means the world has no `fs`, so the program could not reach the host
// if it tried — a sealed session is enforced by the capability world and demonstrated by the mount table,
// rather than being a promise about what the code does.

import { buildApp } from "../../platform/build.ts";
import "../../../harness/spawnRetry.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const sealed = await Deno.makeTempFile({ prefix: "wac-sealed-" });
globalThis.addEventListener("unload", () => {
  try {
    Deno.removeSync(sealed);
  } catch {
    // Already gone, or never built.
  }
});
// No grants. Not `{ read: false }` — absent, which is how this world spells "no such capability".
await buildApp("packages/sh/src/sealed.wac", sealed, {});

function run(script: string, cwd: string) {
  const r = new Deno.Command(sealed, {
    args: ["-c", script],
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    // `PATH` because the shebang is `#!/usr/bin/env -S deno run …` and `env` needs to find `deno`. Without
    // it the binary never starts and every assertion here reads as "the shell printed nothing", which is
    // exactly what the first run of this test said.
    env: { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
    clearEnv: true,
  }).outputSync();
  const dec = new TextDecoder();
  return { code: r.code, out: dec.decode(r.stdout), err: dec.decode(r.stderr) };
}

Deno.test("a sealed shell has a filesystem, and it is not the host's", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wac-sealed-host-" });
  try {
    await Deno.writeTextFile(`${dir}/host-only.txt`, "the host's\n");

    // It has a working filesystem: directories, files, reads, listings.
    assertEquals(run("mkdir d; echo hi > d/f; cat d/f", dir).out, "hi\n");
    assertEquals(run("mkdir a; mkdir a/b; ls a", dir).out, "b\n");
    assertEquals(run("echo x > f; wc -c f", dir).out, "2 f\n");
    assertEquals(run("echo one > f; echo two > f; cat f", dir).out, "two\n");
    assertEquals(run("echo x > f; rm f; ls; echo status=$?", dir).out, "status=0\n");

    // And it is empty at the root, rather than being the host's root with a filter over it.
    assertEquals(run("ls /", dir).out, "");

    // The host's files are not there, including the one in the directory it was started from — a sealed
    // session's cwd is its own, so `.` is not where the process stands.
    const passwd = run("cat /etc/passwd", dir);
    assertEquals(passwd.err.includes("No such file or directory"), true, passwd.err);
    assertEquals(passwd.code, 1);
    assertEquals(run("cat host-only.txt", dir).code, 1, "it read a file from the host directory");

    // Nothing it did reached the host. This is the assertion the whole thread exists for.
    const after = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(after.join(","), "host-only.txt", `the host directory changed: ${after.join(",")}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("two sealed sessions share nothing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wac-sealed-two-" });
  try {
    // Each run is a fresh filesystem, which is what "in the process" means. A test that wants state across
    // commands puts them in one script — and an image, when there is one, is what will change that
    // (design/0001 step 2).
    assertEquals(run("echo remembered > f; cat f", dir).out, "remembered\n");
    const second = run("cat f; echo status=$?", dir);
    assertEquals(second.out, "status=1\n", `the second session saw the first's file: ${second.out}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the sealed binary asks for no filesystem capability at all", async () => {
  // The shebang states what a program may do, so this is checkable rather than a claim: a sealed session
  // that could reach the host would say `--allow-read` here even if it never used it.
  const first = (await Deno.readTextFile(sealed)).split("\n")[0];
  assertEquals(
    first.includes("--allow-read") || first.includes("--allow-write"),
    false,
    `a sealed shell must not ask for the filesystem: ${first}`,
  );
});
