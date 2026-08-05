// `appRunner` against the executable it replaces.
//
// The point of the runner is that a caller cannot tell the difference, so that is what this
// asserts: the same program, the same arguments, the same bytes out and the same exit code, by both
// paths. A runner that were subtly different — a missing newline, a swapped stream, an exit code of
// its own — would be worse than the spawning it saves, because every test built on it would be
// quietly testing something else.

import { appRunner } from "./appRun.ts";
import { buildApp } from "../packages/platform/build.ts";

function eq<T>(got: T, want: T, msg: string): void {
  if (got !== want) throw new Error(`${msg}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
}

const BOX = "packages/box/src/box.wac";

Deno.test("appRun: the worker and the executable agree, argument for argument", async () => {
  const exe = await Deno.makeTempFile({ prefix: "apprun-exe-" });
  const fixture = await Deno.makeTempFile({ prefix: "apprun-in-" });
  try {
    await buildApp(BOX, exe, { read: true });
    await Deno.writeTextFile(fixture, "alpha beta\ngamma\ndelta epsilon zeta\n");
    const box = await appRunner(BOX, { read: true });

    for (const args of [
      ["cat", fixture],
      ["wc", fixture],
      ["nl", fixture],
      ["rev", fixture],
      ["base64", fixture],
      ["sha256sum", fixture],
      ["echo", "hello", "world"],
      ["seq", "1", "5"],
      // A failure has to travel too: no such applet, and no such file.
      ["nosuchapplet"],
      ["cat", `${fixture}.missing`],
    ]) {
      const p = new Deno.Command(exe, { args, stdout: "piped", stderr: "piped" }).outputSync();
      const w = await box.run(args);
      const label = args.join(" ");
      eq(w.out, new TextDecoder().decode(p.stdout), `stdout differs for \`${label}\``);
      eq(w.code, p.code, `exit code differs for \`${label}\``);
    }
  } finally {
    await Deno.remove(exe).catch(() => {});
    await Deno.remove(fixture).catch(() => {});
  }
});

Deno.test("appRun: a filter reads the standard input it is given", async () => {
  const box = await appRunner(BOX, { read: true });
  const r = await box.run(["rev"], { stdin: "abc\ndef\n" });
  eq(r.out, "cba\nfed\n", "rev over stdin");
  eq(r.code, 0, "exit code");
});

Deno.test("appRun: a program that reads to the end sees the end", async () => {
  // `sort` cannot answer until its input is closed, so this is the case that hangs if `in.end()`
  // is forgotten — and hangs rather than fails, which is the worst way for it to be wrong.
  const box = await appRunner(BOX, { read: true });
  const r = await box.run(["sort"], { stdin: "gamma\nalpha\nbeta\n" });
  eq(r.out, "alpha\nbeta\ngamma\n", "sorted");
});

Deno.test("appRun: standard error is its own stream", async () => {
  const box = await appRunner(BOX, { read: true });
  const r = await box.run(["cat", "/nonexistent/definitely-not-here"]);
  if (r.out !== "") throw new Error(`the complaint leaked into stdout: ${JSON.stringify(r.out)}`);
  if (r.err.trim() === "") throw new Error("nothing on stderr for a missing file");
  if (r.code === 0) throw new Error("a missing file exited 0");
});

Deno.test("appRun: a program granted nothing cannot read", async () => {
  // The grants are what the runner passes to the world, so getting them wrong would hand a test
  // more authority than the program it is testing would have had.
  const fixture = await Deno.makeTempFile({ prefix: "apprun-denied-" });
  try {
    await Deno.writeTextFile(fixture, "secret\n");
    const box = await appRunner(BOX, {});
    const r = await box.run(["cat", fixture]);
    if (r.out.includes("secret")) throw new Error("read the file without the read grant");
  } finally {
    await Deno.remove(fixture).catch(() => {});
  }
});
