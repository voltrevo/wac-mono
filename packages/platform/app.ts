// Build a wac application and run it, in one step.
//
//   deno task app <entry.wac> [--allow-read] [--allow-write] [--allow-env]
//                             [--target deno|node] [-- args...]
//
// This *builds* and executes the real artifact rather than running the application by a
// shortcut of its own. That is the point: a dev loop that exercises a different runtime
// from the one that ships is a dev loop that can be green while the product is broken —
// and this package had exactly that, two launchers and two workers, until a change to the
// application contract had to be made twice.
//
// The build costs a few hundred milliseconds. Worth it to be running the thing itself.

import { buildApp, type Grants, type Target } from "./build.ts";

const argv = [...Deno.args];
const sep = argv.indexOf("--");
const flags = sep < 0 ? argv : argv.slice(0, sep);
const appArgs = sep < 0 ? [] : argv.slice(sep + 1);

// The value after `--target` is not the entry. `indexOf` returns -1 when the flag is
// absent, and -1 + 1 is 0 — which excluded the entry itself.
const targetAt = flags.indexOf("--target");
const entry = flags.find((a, i) => !a.startsWith("-") && !(targetAt >= 0 && i === targetAt + 1));
if (entry === undefined) {
  console.error(
    "usage: deno task app <entry.wac> [--allow-read] [--allow-write] [--allow-env]\n" +
      "                    [--target deno|node] [-- args...]",
  );
  Deno.exit(2);
}

const grants: Grants = {
  read: flags.includes("--allow-read"),
  write: flags.includes("--allow-write"),
  env: flags.includes("--allow-env"),
};
const target = (targetAt >= 0 ? flags[targetAt + 1] : "deno") as Target;
if (target !== "deno" && target !== "node") {
  console.error(`unknown target '${target}' — deno or node`);
  Deno.exit(2);
}

const built = await Deno.makeTempFile({ prefix: "wac-app-" });
try {
  await buildApp(entry, built, grants, target);
  // Inherited, not piped: the application's output is the point, and `outputSync`
  // would swallow it.
  const stdio = { stdout: "inherit", stderr: "inherit", stdin: "inherit" } as const;
  const cmd = target === "node"
    ? new Deno.Command("node", { args: [built, ...appArgs], ...stdio })
    : new Deno.Command(built, { args: appArgs, ...stdio });
  const { code } = cmd.outputSync();
  Deno.exit(code);
} finally {
  await Deno.remove(built).catch(() => {});
}
