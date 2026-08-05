// Type-check every TypeScript file in the repository.
//
//   deno task check
//
// wac-mono 0011. `deno test` type-checks the modules it imports, which leaves out every driver and tool
// nothing imports — `cov.ts`, `size.ts`, `validate.ts` — and `deno run` has not type-checked by default
// since Deno 1.23, so those files were checked by nothing. This looks at all of them, in about four
// seconds, which is the fast loop the issue asked for: a type failure named in one command rather than
// after a minute of tests that never got to run.
//
// `tools/typecheck.test.ts` is the same walk as a test, so the suite fails when this would. The task
// exists because four seconds is a thing you run while editing and seventy is not.

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

const files = await typescriptFiles();
const started = performance.now();
const child = new Deno.Command(Deno.execPath(), {
  args: ["check", ...files],
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
// No deadline of its own: `deno check` either finishes or the caller stops waiting, and a timeout here
// would be a clock that decides something — the shape wac-mono 0082 is about.
const status = await child.status;
const took = Math.round(performance.now() - started);
console.log(
  status.code === 0
    ? `type-checked ${files.length} files in ${took}ms`
    : `type errors above, from ${files.length} files (${took}ms)`,
);
Deno.exit(status.code);
