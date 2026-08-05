// Imported for its side effect: retries a spawn that fails with "Text file busy" and names
// whoever held the file, if anyone did. wac-mono 0074.
import "../../../harness/spawnRetry.ts";
// The shell on the Node host, against bash.
//
// `differential.test.ts` runs several hundred scripts through the *Deno* build. The Node host is a different
// implementation of the same contract — its own stdio, filesystem, sockets and worker plumbing — and
// nothing had ever run a script through it. A throwaway sweep of the whole corpus found no divergence,
// so what is committed here is not the corpus.
//
// **These twenty are chosen for the host rather than for the language.** Arithmetic, quoting, `case`
// and parameter expansion all run in the same wasm on both runtimes: comparing them again on Node
// re-tests the compiler, not the host, and costs a process start each time. What differs between the
// two hosts is the capability calls — a redirection is `writeFile`, a here-document is a buffer, `cd`
// is the shell's own path resolution against `cwd`, a glob is `readDir`, a command substitution is a
// capturing shell, a pipeline is `send`/`recv` — so those are what is here.
//
// One case per capability, and each one's answer comes from bash rather than from this file.

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const haveNode = await (async () => {
  try {
    return (await new Deno.Command("node", { args: ["--version"], stdout: "null" }).output()).success;
  } catch {
    return false;
  }
})();

const haveBash = await (async () => {
  try {
    return (await new Deno.Command("bash", { args: ["-c", "exit 0"] }).output()).success;
  } catch {
    return false;
  }
})();

/** Scripts that touch the host, and the input each one is given. */
const CASES: { script: string; stdin?: string }[] = [
  // Redirection: `writeFile`, then the append form, then reading one back.
  { script: "echo hi > f; cat f" },
  { script: "echo one > f; echo two >> f; cat f" },
  { script: "echo x > f; cat < f" },
  // A here-document, which is a buffer the shell holds rather than anything on the host.
  { script: "cat <<EOF\nin the script\nEOF" },
  // Command substitution: a capturing shell inside this one.
  { script: "echo $(echo inner)" },
  { script: "x=$(printf 'a\\nb\\n' | wc -l); echo $x" },
  // Pipelines, which are `send` and `recv` between stages.
  { script: "seq 1 5 | head -2" },
  { script: "seq 1 5 | sort -r | head -2" },
  { script: "printf 'b\\na\\nb\\n' | sort | uniq" },
  // The shell's own standard input, in three shapes.
  { script: "cat", stdin: "piped in\n" },
  { script: 'read x; echo "[$x]"; cat', stdin: "one\ntwo\n" },
  { script: "while read l; do echo \"got $l\"; done", stdin: "a\nb\n" },
  // `cd` and `pwd`, which are the shell's path resolution over the host's `cwd`. The directory each
  // case runs in is a fresh temp one, so `pwd` names a different path for bash than for us — the two
  // outputs are compared with that prefix replaced, which is the one thing here that cannot come from
  // bash. Nothing external in the script: this build is granted read, write and env but not `run`, so
  // `sed` would be "command not found" and the case would be about the permission rather than `cd`.
  { script: "mkdir -p d/e; cd d/e; pwd" },
  { script: "mkdir -p d; cd d; echo deep > g; cat g" },
  // Globbing, which is `readDir`. The files are made by redirection rather than by `touch`: this
  // shell wires thirteen programs and `touch` is not one of them, so `touch a.txt` is "command not
  // found" and the case would have tested the *absence* of an applet.
  { script: "echo x > a.txt; echo y > b.txt; echo *.txt" },
  { script: "echo x > a.txt; echo *.nope" },
  // The mutation tier's failures, whose wording is the category's rather than the host's — Node and
  // Deno word the same errno differently ("EEXIST: file already exists" against "os error 17").
  // No `2>` here even though the wording is what we are avoiding: this shell does not redirect fd 2
  // (`2>/dev/null` says so, `2>&1` is a syntax error), and the runner discards stderr for both sides
  // anyway, so the status is all that is left to compare.
  { script: "mkdir taken; mkdir taken; echo status=$?" },
  { script: "rm nosuchthing; echo status=$?" },
  // A compound's output redirected as a whole, and read back.
  { script: "for i in 1 2 3; do echo $i; done > out; cat out" },
  // `exit` from a script, which is the launcher's exit code.
  { script: "echo before; exit 3; echo after" },
];

Deno.test({
  name: "the shell on Node answers what bash answers, for everything that touches the host",
  ignore: !haveNode || !haveBash,
  fn: async () => {
    const { buildApp } = await import("../../platform/build.ts");
    const built = await Deno.makeTempFile({ prefix: "sh-node-diff-" });
    try {
      await buildApp("packages/sh/src/sh.wac", built, { read: true, write: true, env: true }, "node");

      for (const { script, stdin } of CASES) {
        // A directory of its own per case: several of these write files, and one leaking into the next
        // would make a passing test depend on the order they happen to run in.
        const run = async (cmd: string, args: string[]) => {
          const cwd = await Deno.makeTempDir({ prefix: "sh-node-case-" });
          try {
            const child = new Deno.Command(cmd, {
              args,
              cwd,
              stdin: "piped",
              stdout: "piped",
              stderr: "null",
              env: { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
              clearEnv: true,
            }).spawn();
            const w = child.stdin.getWriter();
            await w.write(new TextEncoder().encode(stdin ?? ""));
            await w.close();
            const out = await child.output();
            // The temp directory's name is the one difference between the two runs that is not the
            // shell's answer, so it is taken out of both. `realPath` as well as the path itself, since
            // a `pwd` may report either.
            const real = await Deno.realPath(cwd).catch(() => cwd);
            return {
              out: new TextDecoder().decode(out.stdout).replaceAll(real, "<cwd>").replaceAll(
                cwd,
                "<cwd>",
              ),
              code: out.code,
            };
          } finally {
            await Deno.remove(cwd, { recursive: true });
          }
        };

        const theirs = await run("bash", ["-c", script]);
        const ours = await run("node", [built, "-c", script]);
        assertEquals(ours.out, theirs.out, `${JSON.stringify(script)}: output`);
        assertEquals(ours.code, theirs.code, `${JSON.stringify(script)}: exit status`);
      }
    } finally {
      await Deno.remove(built);
    }
  },
});
