// `pushChild` and `popChild`: a program running inside another one.
//
// Driven through `example/inside.wac`, which is the smallest thing that uses all of it — its own
// argv, its own standard input, its own working directory, and both output streams kept rather
// than written. The assertions are on what the *parent* printed, because the point of the
// capability is that the child printed nothing anybody else can see.

import { buildApp } from "../build.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

function assertIncludes(got: string, want: string, msg?: string): void {
  if (!got.includes(want)) {
    throw new Error(
      `assertIncludes failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want to contain: ${JSON.stringify(want)}`,
    );
  }
}

const INSIDE = "packages/platform/example/inside.wac";

async function run(): Promise<{ out: string; err: string; code: number }> {
  const built = await Deno.makeTempFile({ prefix: "wac-inside-" });
  const dir = await Deno.makeTempDir({ prefix: "wac-inside-d-" });
  try {
    await buildApp(INSIDE, built, { read: true, write: true });
    const r = new Deno.Command(built, { args: [dir], stdout: "piped", stderr: "piped" })
      .outputSync();
    const dec = new TextDecoder();
    return { out: dec.decode(r.stdout), err: dec.decode(r.stderr), code: r.code };
  } finally {
    await Deno.remove(built);
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a child's output comes back to its caller and goes nowhere else", async () => {
  const { out, err, code } = await run();
  assertEquals(code, 0);

  // Everything the child wrote, in the order it wrote it: `write` of its uppercased input, `write`
  // of the file it opened, then a `core.log` — because `log` is standard output too, and a capture
  // that took only `write` would lose the thirty `box` applets that report that way.
  assertEquals(
    out,
    ["status 0", "out   FROM STDIN\\nFROM THE FILE\\nread 14 bytes\\n", "err   shout: nothing wrong, just talking\\n"]
      .join("\n") + "\n",
  );

  // And the child's own streams reached neither of the parent's. `err` here is the parent's
  // standard error, which stayed empty while the child was complaining into its buffer.
  assertEquals(err, "");
});

Deno.test("a child reads what it was fed, not the terminal's standard input", async () => {
  const built = await Deno.makeTempFile({ prefix: "wac-inside-" });
  const dir = await Deno.makeTempDir({ prefix: "wac-inside-d-" });
  try {
    await buildApp(INSIDE, built, { read: true, write: true });
    // Something on the real standard input that the child must *not* see. Without the check in
    // `READ_CHUNK` a filter running inside a shell would swallow the terminal.
    const child = new Deno.Command(built, {
      args: [dir],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode("THE PARENT'S OWN INPUT\n"));
    await w.close();
    const r = await child.output();
    const out = new TextDecoder().decode(r.stdout);
    assertIncludes(out, "FROM STDIN");
    assertEquals(out.includes("PARENT"), false, out);
  } finally {
    await Deno.remove(built);
    await Deno.remove(dir, { recursive: true });
  }
});
