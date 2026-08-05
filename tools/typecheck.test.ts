// Every TypeScript file in the repo type-checks, not only the ones a test imports.
//
// wac-mono 0011, which is about a type error reaching the primary branch and failing `deno task test`
// for everyone before a single test runs. The remedies it listed were "run the suite before pushing"
// — `tools/push.sh` does that now — and "a `deno check` as its own task, so the type failure is one
// fast command rather than a whole suite".
//
// Both miss half the repo, and the half they miss is the half that rots. `deno test` type-checks the
// modules it *imports*: a test file, and whatever that reaches. It never imports `packages/gzip/cov.ts`,
// `tools/size.ts` or `tools/validate.ts`, and `deno run` has not type-checked by default since Deno 1.23
// — so those files are checked by nothing at all. The first run of this check found **six errors** in
// three such files, one of them real: `tools/size.ts` cast the compiler's result to a hand-written
// `{ ok, compiled? }`, so `warm.diagnostics` was a property the cast had thrown away and the
// "did not compile" branch printed no diagnostics at all — silently, in the one case that tool exists
// to report loudly.
//
// Four seconds cold, and less warm, for the whole repository. That is cheap enough to be a test rather
// than a task somebody remembers to run, which is the difference between this recurring and not.

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/** Every `.ts` under the roots, as paths relative to the repository. */
async function typescriptFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === ".cache") continue;
        await walk(path);
      } else if (e.name.endsWith(".ts")) {
        out.push(path);
      }
    }
  };
  for (const root of ["packages", "harness", "tools"]) await walk(root);
  out.sort();
  return out;
}

Deno.test("every TypeScript file in the repo type-checks", async () => {
  const files = await typescriptFiles();
  // A floor, so this cannot pass by checking nothing — the failure mode of every "run a tool over the
  // repo" test, and invisible because an empty run is also a green one.
  assertEquals(files.length > 200, true, `only ${files.length} files found; the walk is broken`);

  const r = await new Deno.Command(Deno.execPath(), {
    args: ["check", ...files],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  const text = `${dec.decode(r.stdout)}${dec.decode(r.stderr)}`;
  assertEquals(
    r.code,
    0,
    `${files.length} files, and some do not type-check.\n` +
      `Files a test imports are checked by \`deno test\`; these are the rest.\n\n${text}`,
  );
});
