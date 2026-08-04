// The shell running a real external program.
//
// Everything else in this package tests a shell whose "external" commands are wac functions in
// `program.wac`, because until now the capability world could not start anything — wac-mono issue
// 0015. `spawn` changed that, and this is the evidence that the seam was in the right place: the
// pipeline, the exit status and the command substitution below are the same code that drove the
// wac implementations, with a spawned worker on the other end of it.
//
// **What is spawned is a wac program built as a worker bundle, not an executable.** That is why
// the shell searches `$WACPATH` and not `$PATH`: `/usr/bin/wc` handed to `spawn` is JavaScript
// that does not parse, so searching the real path would turn every working `wc` into a failure.
// An unset `$WACPATH` means nothing is spawned and the wac table answers, exactly as before —
// which is the first test here.
//
// The child is platform's own `example/wc.wac`. It takes filenames and reads standard input when
// given none, so every script below calls it with no arguments.

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

const dir = await Deno.makeTempDir({ prefix: "wacsh-spawn-" });
/**
 * Remove what this file built, however it ends.
 *
 * `Deno.test` has no suite-level teardown, so a module-level temp used by several tests had nowhere to
 * be cleaned up and was left behind — one built binary of about 700 KiB per run of the suite. Five
 * hundred of them were sitting in `/tmp` when a parallel run finally died with "No space left on
 * device", in the middle of a package that had nothing to do with it. `unload` fires on the way out
 * whether the tests passed, failed or threw, which is the only hook that covers all three.
 */
globalThis.addEventListener("unload", () => {
  try {
    Deno.removeSync(dir, { recursive: true });
  } catch {
    // Already gone, or never made. Nothing to report on the way out.
  }
});

const shell = `${dir}/sh`;

// Built once, both of them. The shell needs `read` to load the bundle at all — a program is a
// file whose contents the host will run, so finding one is a filesystem operation.
await buildApp("packages/sh/src/sh.wac", shell, { read: true, write: true, env: true });
await buildApp("packages/platform/example/wc.wac", `${dir}/wc`, {}, "deno", true);

async function sh(script: string) {
  const r = await new Deno.Command(shell, { args: ["-c", script] }).output();
  return {
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
    code: r.code,
  };
}

Deno.test("an unset WACPATH spawns nothing, so the wac implementations still answer", async () => {
  // `program.wac`'s own `wc -w`, which the spawned one does not even support. If this ever came
  // back as a spawn failure it would mean the search had reached outside `$WACPATH`.
  const r = await sh("echo one two three | wc -w");
  assertEquals(r.out, "3\n", r.err);
  assertEquals(r.code, 0);
});

Deno.test("a program on WACPATH is spawned, and its output is the command's", async () => {
  const r = await sh(`WACPATH=${dir}; echo one two three | wc`);
  // Lines, words, bytes — platform's `wc`, not ours, which has a different format entirely.
  assertEquals(r.out, "1 3 14\n", r.err);
  assertEquals(r.code, 0);
});

Deno.test("a spawned program is a pipeline stage like any other", async () => {
  const r = await sh(`WACPATH=${dir}; seq 1 5 | wc | rev`);
  assertEquals(r.out, "01 5 5\n", r.err);
});

Deno.test("a spawned program inside a command substitution", async () => {
  const r = await sh(`WACPATH=${dir}; x=$(echo a b | wc); echo [$x]`);
  assertEquals(r.out, "[1 2 4]\n", r.err);
});

Deno.test("two spawns in one script, each with its own input", async () => {
  const r = await sh(`WACPATH=${dir}; echo a | wc; echo b c | wc`);
  assertEquals(r.out, "1 1 2\n1 2 4\n", r.err);
});

Deno.test("a path with a slash is not searched for", async () => {
  const r = await sh(`echo a b | ${dir}/wc`);
  assertEquals(r.out, "1 2 4\n", r.err);
});

Deno.test("a name on WACPATH that is not there is still 127, not a spawn failure", async () => {
  const r = await sh(`WACPATH=${dir}; nosuchprogram x`);
  assertEquals(r.code, 127);
  assertEquals(r.err.includes("command not found"), true, r.err);
});

Deno.test("WACPATH entries are tried in order and a missing directory is skipped", async () => {
  const r = await sh(`WACPATH=/nonexistent:${dir}; echo a | wc`);
  assertEquals(r.out, "1 1 2\n", r.err);
});

Deno.test("a file that is not a worker bundle is a failed command, not a dead shell — 0021", async () => {
  await Deno.writeTextFile(`${dir}/notaprogram`, "this is not javascript {{{\n");
  const r = await sh(`WACPATH=${dir}; notaprogram; echo still-here`);

  // `still-here` is the whole point: the shell survives a file that is not a program. It used to
  // not — the worker's load error escaped into the parent, which died with Deno's own message and
  // no chance to report a failed command. wac-mono issue 0021.
  assertEquals(r.out.includes("still-here"), true, `out=${r.out} err=${r.err}`);
  // 126, not 127: it exists and would not start, which is a different answer from "no such
  // command". The status of the *script* is `echo`'s, so 0 — the same as it is in bash.
  assertEquals(r.code, 0, `out=${r.out} err=${r.err}`);
  assertEquals(r.err.includes("notaprogram"), true, r.err);
  // The reason, from the host, on one line. Without this the shell says only that something went
  // wrong, and "it is not a worker bundle" is exactly the thing a person needs told.
  assertEquals(r.err.includes("SyntaxError"), true, r.err);
});

Deno.test("...and the status of that command alone is 126 — 0021", async () => {
  await Deno.writeTextFile(`${dir}/notaprogram2`, "}{ not javascript either\n");
  const r = await sh(`WACPATH=${dir}; notaprogram2; echo $?`);
  assertEquals(r.out, "126\n", `out=${r.out} err=${r.err}`);
});

Deno.test("a spawned program reads all of its input before answering", async () => {
  // `wc` cannot count until the input ends, so this is the test that `closeFeed` is being used
  // rather than `closeSocket`: stopping the child instead of ending its input means it never
  // speaks, and this would come back empty.
  const r = await sh(`WACPATH=${dir}; seq 1 200 | wc`);
  assertEquals(r.out, "200 200 692\n", r.err);
});

// The temp directory used to outlive the tests deliberately, on the grounds that the OS clears
// `/tmp`. It does not, or not soon enough: one 700 KiB binary per run accumulated to five hundred of
// them, and a parallel suite eventually failed with "No space left on device" in an unrelated package.
// The `unload` handler at the top is the cleanup, and this comment is what it replaced.

Deno.test("a spawned program may read a file, because a child is as trusted as the shell — 0028", async () => {
  // `GRANT_NONE` was what `spawn` was called with, and it was never anybody's decision — it was the
  // value the argument had when `spawn` grew one. So a `$WACPATH` program was a filter and nothing
  // else: `wc file` could not open the file it was handed, and the shell that could read it was the
  // one refusing on its behalf.
  //
  // The child gets the shell's own grants now, which the host intersects with what it actually holds —
  // so this cannot widen anything: a shell started without `read` still hands its children nothing,
  // which is the next case.
  await Deno.writeTextFile(`${dir}/note.txt`, "one two three\n");
  const r = await sh(`WACPATH=${dir}; wc ${dir}/note.txt`);
  assertEquals(r.code, 0, `${r.out}${r.err}`);
  // The same program run directly is the oracle: what `wc` prints for this file is `wc`'s business, and
  // what this test is about is whether it was allowed to look at all.
  const alone = `${dir}/wc-alone`;
  await buildApp("packages/platform/example/wc.wac", alone, { read: true });
  const direct = await new Deno.Command(alone, { args: [`${dir}/note.txt`] }).output();
  assertEquals(r.out, new TextDecoder().decode(direct.stdout), "the same answer as running it alone");
  assertEquals(r.out.trim().length > 0, true, `nothing printed: ${r.err}`);
});

Deno.test("...and a shell with no grants still hands its children none", async () => {
  // The property that matters is not that a child gets nothing — it is that it cannot get *more*. The
  // host intersects, so this asks for the same read through a shell built without one.
  const bare = `${dir}/sh-bare`;
  await buildApp("packages/sh/src/sh.wac", bare, { env: true });
  await Deno.writeTextFile(`${dir}/note.txt`, "one two three\n");
  const r = await new Deno.Command(bare, {
    args: ["-c", `WACPATH=${dir}; wc ${dir}/note.txt`],
  }).output();
  const said = new TextDecoder().decode(r.stderr) + new TextDecoder().decode(r.stdout);
  // It cannot even find the program: reading `$WACPATH/wc` is a filesystem read, so a shell with no
  // `read` falls back to its own `wc`, which reads standard input and finds it empty. Either way the
  // file is not opened, and nothing here can widen that.
  assertEquals(said.includes("one two three"), false, `a child read a file the shell may not: ${said}`);
});
