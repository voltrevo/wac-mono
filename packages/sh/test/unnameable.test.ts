// What a shell says about a file it can list and cannot open.
//
// wac-mono 0065. `bad-\xff-name` is an ordinary file on this filesystem and an unnameable one from Deno:
// `readDir` replaces the invalid byte with U+FFFD and every path built from that name fails. So `ls` shows
// a file that nothing can touch, and until now every program said "No such file or directory" about it —
// which reads as *the caller got the name wrong* rather than *this runtime cannot express it*.
//
// **Not a differential case.** bash handles these names perfectly: `cat $'bad-\xff-name'` prints the file.
// Comparing against it would only restate the gap, and the corpus asserts agreement. So this file asserts
// our own sentence instead, and `packages/sh/README.md` records the divergence.
//
// The fixture is made with bash, because neither Deno nor this shell can create such a file: both take a
// path as a string, and the string that would name it does not exist.

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

const shell = await Deno.makeTempFile({ prefix: "wacsh-unnameable-" });
globalThis.addEventListener("unload", () => {
  try {
    Deno.removeSync(shell);
  } catch {
    // Already gone, or never built.
  }
});
await buildApp("packages/sh/src/sh.wac", shell, { read: true, write: true, env: true });

/** A directory holding one ordinary file and one whose name is not valid UTF-8. */
async function fixture(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "wac-unnameable-" });
  await Deno.writeTextFile(`${dir}/plain.txt`, "ordinary\n");
  const made = new Deno.Command("bash", {
    // `$'…'` is bash's byte-literal syntax, and bash is the only thing here that can write this name.
    args: ["-c", `printf 'invalid\\n' > "$1"/$'bad-\\xff-name'`, "bash", dir],
    stdout: "null",
    stderr: "piped",
  }).outputSync();
  if (!made.success) {
    throw new Error(`could not create the fixture: ${new TextDecoder().decode(made.stderr)}`);
  }
  return dir;
}

function sh(script: string, cwd: string) {
  const r = new Deno.Command(shell, {
    args: ["-c", script],
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
    clearEnv: true,
  }).outputSync();
  const dec = new TextDecoder();
  return { code: r.code, out: dec.decode(r.stdout), err: dec.decode(r.stderr) };
}

Deno.test("a file that cannot be named says so, rather than saying it is missing", async () => {
  const dir = await fixture();
  try {
    // It is listed, because the host can enumerate it even though it cannot open it. That asymmetry is the
    // whole problem, so it is asserted rather than assumed.
    const listing = sh("ls", dir);
    assertEquals(listing.out.includes("plain.txt"), true, listing.out);
    assertEquals(listing.out.includes("�"), true, `the lossy name should be listed: ${listing.out}`);

    // And every program that opens it says which side is at fault. The glob is how a script would reach
    // it — nobody can type this name.
    for (const [script, program] of [["cat bad-*-name", "cat"], ["wc -l bad-*-name", "wc"]] as const) {
      const r = sh(script, dir);
      assertEquals(
        r.err.includes("cannot be named on this host"),
        true,
        `${program} should name the gap, said: ${JSON.stringify(r.err)}`,
      );
      assertEquals(
        r.err.includes("No such file or directory"),
        false,
        `${program} still blames the caller: ${JSON.stringify(r.err)}`,
      );
      assertEquals(r.code, 1, `${program} exited ${r.code}`);
    }

    // A genuinely missing file must still be missing, in GNU's words — the category the refinement could
    // most easily have swallowed.
    const absent = sh("cat no-such-file", dir);
    assertEquals(absent.err.includes("No such file or directory"), true, absent.err);
    assertEquals(absent.err.includes("cannot be named"), false, absent.err);

    // And the ordinary file in the same directory is untouched.
    assertEquals(sh("cat plain.txt", dir).out, "ordinary\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("removing one says the same thing, so a script cannot mistake it for gone", async () => {
  const dir = await fixture();
  try {
    const r = sh("rm bad-*-name; echo status=$?", dir);
    assertEquals(
      r.err.includes("cannot be named on this host"),
      true,
      `rm should name the gap, said: ${JSON.stringify(r.err)}`,
    );
    assertEquals(r.out.trim(), "status=1");
    // `rm -f` exists to ignore *absence*, and this is not absence: a file that is still there afterwards
    // must not be reported as removed.
    const forced = sh("rm -f bad-*-name; echo status=$?", dir);
    assertEquals(
      forced.err.includes("cannot be named on this host"),
      true,
      `rm -f swallowed a failure that is not absence: ${JSON.stringify(forced.err)}`,
    );
    assertEquals(forced.out.trim(), "status=1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
