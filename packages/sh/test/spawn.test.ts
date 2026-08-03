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

Deno.test("a file that is not a worker bundle takes the shell down — issue 0020", async () => {
  await Deno.writeTextFile(`${dir}/notaprogram`, "this is not javascript {{{\n");
  const r = await sh(`WACPATH=${dir}; notaprogram; echo still-here`);

  // This asserts what *currently* happens, not what should. A worker whose source does not parse
  // throws into the parent, which dies before the shell can call it a failed command — wac-mono
  // issue 0020. The shell already produces 126 for a `Child` that comes back with `handle < 0`,
  // so when that is fixed this test flips to `assertEquals(r.code, 126)` and the `still-here`
  // check becomes the point rather than the evidence.
  assertEquals(r.out.includes("still-here"), false, "0020 is fixed — update this test to expect 126");
  assertEquals(r.code, 1, `out=${r.out} err=${r.err}`);
  assertEquals(r.err.includes("child worker"), true, r.err);
});

Deno.test("a spawned program reads all of its input before answering", async () => {
  // `wc` cannot count until the input ends, so this is the test that `closeFeed` is being used
  // rather than `closeSocket`: stopping the child instead of ending its input means it never
  // speaks, and this would come back empty.
  const r = await sh(`WACPATH=${dir}; seq 1 200 | wc`);
  assertEquals(r.out, "200 200 692\n", r.err);
});

// The temp directory outlives the tests deliberately: Deno.test has no suite-level teardown here,
// and the leak is one directory per run in `/tmp`, which the OS clears.
