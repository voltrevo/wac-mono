// Imported for its side effect: retries a spawn that fails with "Text file busy" and names
// whoever held the file, if anyone did. wac-mono 0074.
import "../../../harness/spawnRetry.ts";
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
//
// ## One process, not one per option
//
// This used to spawn the built shell once per option — about 135 of them — and take 17 to 31
// seconds, which is most of what `packages/sh` costs. The oracle is not what was expensive: a
// `--help` costs 2.5ms and there are nine of them, while starting our own binary costs **167ms**,
// because it is a 400 KB bundle that instantiates a wasm module every time.
//
// So the cases run as one script, and the assertion is read off the combined standard error: if the
// word "invalid option" is absent, every option was accepted and there is nothing to attribute. A
// trailing sentinel proves the batch reached the end rather than dying somewhere in the middle.
//
// When the fast path *does* find something, it says which option only after re-running them
// singly — which is the one case where 135 spawns are worth it, and is not the case that runs on
// every commit.

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
      const cases: { tool: string; letter: string; script: string }[] = [];
      for (const tool of tools) {
        for (const letter of await gnuOptions(tool)) {
          // The pattern for `grep` and the sets for `tr` are there so a *working* flag is exercised
          // rather than a usage error.
          cases.push({
            tool,
            letter,
            script: tool === "grep"
              ? `echo x | grep -${letter} x`
              : tool === "tr"
              ? `echo x | tr -${letter} a b`
              : `echo x | ${tool} -${letter}`,
          });
        }
      }
      // If the tools were all missing this test would pass while checking nothing.
      assertEquals(cases.length > 40, true, `only ${cases.length} options found — are the coreutils installed?`);

      const shell = (script: string) => {
        const r = new Deno.Command(built, {
          args: ["-c", script],
          stdout: "piped",
          stderr: "piped",
          env: { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
          clearEnv: true,
        }).outputSync();
        const dec = new TextDecoder();
        return { out: dec.decode(r.stdout), err: dec.decode(r.stderr) };
      };

      // ── The fast path: every case in one process ────────────────────────────
      const SENTINEL = "__gaps_reached_the_end__";
      const batch = shell([...cases.map((c) => c.script), `echo ${SENTINEL}`].join("; "));
      const finished = batch.out.includes(SENTINEL);
      const complained = batch.err.includes("invalid option");
      if (finished && !complained) return;

      // ── The slow path: only now is it worth 135 processes ───────────────────
      const blamed: string[] = [];
      for (const c of cases) {
        const r = shell(c.script);
        if (r.err.includes("invalid option")) {
          blamed.push(`${c.script}: GNU's ${c.tool} has -${c.letter}, and this called it invalid:\n    ${r.err.trim().split("\n")[0]}`);
        }
      }

      if (blamed.length > 0) {
        throw new Error(`${blamed.length} of ${cases.length} options were called invalid:\n  ${blamed.join("\n  ")}`);
      }
      // Nothing to blame, so the batch itself is what went wrong: it stopped early, and the cases
      // after that point were never run. Saying so beats passing on a partial sweep.
      throw new Error(
        finished
          ? `the batch said "invalid option" but no single case does — the batching is wrong, not the shell:\n${batch.err.trim()}`
          : `the batch stopped before the end, so it checked fewer than ${cases.length} options.\n` +
            `  stderr: ${batch.err.trim().split("\n").slice(0, 3).join("\n  ")}`,
      );
    } finally {
      await Deno.remove(built);
    }
  },
});
