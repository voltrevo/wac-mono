// `packages/box/src/bin/sh.wac` — the shell with every applet in this package as a command.
//
// This binary had no test at all, which mattered once it stopped merely *calling* its applets. It
// now runs each one as a spawned child: its own wasm instance, its own grants, its own two streams.
// The three things that can go wrong with that are all here — the program has to be able to be its
// own applets, the child has to stand where the shell stands, and a child's error output must not
// arrive in the pipe.
//
// Compared against bash where the answer is bash's to give. `packages/sh` has its own differential
// suite of 539 scripts against bash; this file is about the *wiring*, not the language.

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

const dir = await Deno.makeTempDir({ prefix: "box-shell-" });
const shell = `${dir}/wacsh`;
await buildApp("packages/box/src/bin/sh.wac", shell, { read: true, write: true, env: true });

function run(args: string[], stdin = "", cwd = dir) {
  const r = new Deno.Command(shell, { args, cwd, stdin: "piped", stdout: "piped", stderr: "piped" })
    .spawn();
  const w = r.stdin.getWriter();
  void w.write(new TextEncoder().encode(stdin)).then(() => w.close());
  return r.output().then((out) => ({
    code: out.code,
    out: new TextDecoder().decode(out.stdout),
    err: new TextDecoder().decode(out.stderr),
  }));
}

const sh = (script: string, stdin = "", cwd = dir) => run(["-c", script], stdin, cwd);

Deno.test("the shell's applets are programs of its own, spawned", async () => {
  // The multi-call entry, used directly: this binary *is* its applets, which is what makes
  // `spawnSelf` able to run them. Without it a spawned applet would start another shell.
  const direct = await run(["sort", "-n"], "10\n2\n33\n");
  assertEquals(direct.out, "2\n10\n33\n", direct.err);

  // And through the shell, which is the same bundle spawned again with different arguments.
  const piped = await sh("printf '10\\n2\\n33\\n' | sort -n | head -2");
  assertEquals(piped.out, "2\n10\n", piped.err);
  assertEquals(piped.code, 0, piped.err);
});

Deno.test("a spawned applet stands where the shell stands", async () => {
  // The shell's `cd` has to reach its children, or `cd sub; cat f` reads the wrong file — a spawned
  // program used to inherit the *host's* directory, which made the shell's own state invisible to
  // everything it ran. `spawn` and `spawnSelf` take a directory for this reason.
  await Deno.mkdir(`${dir}/sub`, { recursive: true });
  await Deno.writeTextFile(`${dir}/sub/f.txt`, "hello from sub\n");

  const r = await sh("cd sub; cat f.txt; pwd");
  assertEquals(r.out, `hello from sub\n${dir}/sub\n`, r.err);

  const theirs = await new Deno.Command("bash", {
    args: ["-c", "cd sub; cat f.txt; pwd"],
    cwd: dir,
    stdout: "piped",
    stderr: "null",
  }).output();
  assertEquals(r.out, new TextDecoder().decode(theirs.stdout), "and bash agrees");
});

Deno.test("a spawned applet's error output stays out of the pipe", async () => {
  // The regression this exists for: a child had *one* stream back to its parent, so its complaint
  // arrived on the same handle as its output — `cat nosuch | wc -c` counted the error message, and
  // `cat nosuch` printed it to standard output. A child has two handles now.
  const piped = await sh("cat nosuchfile | wc -c");
  assertEquals(piped.out.trim(), "0", `the pipe carried the complaint: ${piped.out}`);
  assertEquals(piped.err.includes("nosuchfile"), true, piped.err);

  const alone = await sh("cat nosuchfile");
  assertEquals(alone.out, "", `it went to standard output: ${alone.out}`);
  assertEquals(alone.err.includes("nosuchfile"), true, alone.err);
  assertEquals(alone.code, 1, alone.err);

  // bash puts the complaint on stderr and nothing in the pipe, which is the whole claim.
  const theirs = new Deno.Command("bash", {
    args: ["-c", "cat nosuchfile | wc -c"],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  assertEquals(
    new TextDecoder().decode(theirs.stdout).trim(),
    piped.out.trim(),
    "bash counts nothing either",
  );
});

Deno.test("...and a redirection of standard error still refuses rather than approximating", async () => {
  // `2>` is not supported and says so. Worth pinning beside the streams work: now that a child
  // really has two of them, the temptation to half-implement this is new.
  const r = await sh("cat nosuchfile 2>/dev/null");
  assertEquals(r.err.includes("redirecting fd 2"), true, r.err);
});

Deno.test("an endless producer stops at the cap rather than filling memory", async () => {
  // `yes` writes for ever by design, and `head -1` wants one line. A real shell ends this because
  // `head` closing its input stops `yes`; this shell runs its stages one at a time, so what ends it
  // is the 8 MiB cap on a queue nobody is reading — `write` starts answering false and `yes` is
  // written to notice. Before the cap existed on a *spawned* child's queue, a browser tab died of
  // this: the in-process route had one and the new route did not. Issue 0038 is the real fix.
  const r = await sh("yes | head -1; echo status=$?");
  assertEquals(r.out, "y\nstatus=0\n", r.err);

  // And the input a parent *sends* is never dropped, however much of it there is. The first cap
  // applied to every queue including a child's input, and on a loaded machine this came back as
  // "status=0" with no `y` at all: 8 MiB went into `head`'s input before `head` began reading, and
  // the overflow was discarded in silence. A cap belongs where a producer can be told to stop.
  const big = await sh("seq 1 200000 | tail -1");
  assertEquals(big.out.trim(), "200000", big.err);
});
