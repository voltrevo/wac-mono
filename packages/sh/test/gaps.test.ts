// What this shell says about the things it does not do.
//
// A gap has three possible answers and they are not equally good. Doing something plausible anyway is
// the worst — `tr -d 12` translating, `wc -m` counting bytes, `grep -E 'a|b'` searching for the literal
// — because it is a wrong answer nothing can see. Refusing is better. Saying *which side is incomplete*
// is better still, and that is the only one of the three that tells the truth: a caller who writes
// `wc -m` has written a real flag, and answering "invalid option" says their command is wrong when this
// program is merely unfinished.
//
// So this file asserts the property rather than the wording: **no option that GNU has is ever called
// invalid.** The letters come from the installed tools' own `--help`, so the table in `program.wac`
// cannot drift away from the coreutils on this machine without something failing.

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/** The short options a real tool documents, from its own help text. */
async function gnuOptions(tool: string): Promise<string[]> {
  const r = await new Deno.Command(tool, { args: ["--help"], stdout: "piped", stderr: "piped" })
    .output().catch(() => null);
  if (r === null || !r.success) return [];
  const help = new TextDecoder().decode(r.stdout);
  const letters = new Set<string>();
  for (const m of help.matchAll(/^\s+-([a-zA-Z])[,\s]/gm)) letters.add(m[1]);
  return [...letters];
}

Deno.test({
  name: "no option that GNU has is called invalid — a gap says it is a gap",
  fn: async () => {
    const { buildApp } = await import("../../platform/build.ts");
    const built = await Deno.makeTempFile({ prefix: "wacsh-gaps-" });
    try {
      await buildApp("packages/sh/src/sh.wac", built, { read: true, write: true, env: true });

      // The eight of this shell's twelve programs that a real tool exists for. `printf`, `seq`, `echo`
      // and `cat` take no letter this cares about.
      const tools = ["wc", "head", "tail", "sort", "uniq", "nl", "rev", "grep", "tr"];
      let checked = 0;
      for (const tool of tools) {
        const letters = await gnuOptions(tool);
        if (letters.length === 0) continue;   // tool absent: nothing to compare against
        for (const letter of letters) {
          // Through the shell, because that is how these programs are reached. The pattern for `grep`
          // and the sets for `tr` are there so a *working* flag is exercised rather than a usage error.
          const script = tool === "grep"
            ? `echo x | grep -${letter} x`
            : tool === "tr"
            ? `echo x | tr -${letter} a b`
            : `echo x | ${tool} -${letter}`;
          const r = new Deno.Command(built, {
            args: ["-c", script],
            stdout: "null",
            stderr: "piped",
            env: { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
            clearEnv: true,
          }).outputSync();
          const said = new TextDecoder().decode(r.stderr);
          assertEquals(
            said.includes("invalid option"),
            false,
            `${script}: GNU's ${tool} has -${letter}, and this called it invalid:\n  ${said.trim()}`,
          );
          checked++;
        }
      }
      // If the tools were all missing this test would pass while checking nothing.
      assertEquals(checked > 40, true, `only ${checked} options checked — are the coreutils installed?`);
    } finally {
      await Deno.remove(built);
    }
  },
});
