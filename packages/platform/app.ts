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
//
// **What this cannot promise is that killing it kills the application.** It spawns the built artifact
// as a child and forwards `SIGINT` and `SIGTERM`, so Ctrl-C and an ordinary `kill` reach the program.
// `SIGKILL` cannot be caught by anyone, so a caller that must be *certain* the application dies with
// its launcher should build once and run the artifact directly — which is faster anyway when a test
// starts several of them. `packages/ssh`'s server tests do exactly that, after this gap left 57
// orphaned servers and 13,736 zombies behind them against a container limit of 14,180 process ids.
// Issue 0017.

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
      "                    [--allow-net]\n" +
      "                    [--target deno|node] [-- args...]",
  );
  Deno.exit(2);
}

const grants: Grants = {
  read: flags.includes("--allow-read"),
  write: flags.includes("--allow-write"),
  env: flags.includes("--allow-env"),
  // Missing here while `build.ts` had it, so a networked application ran when built and reported
  // "network access not granted" under `deno task app` — the dev loop broken and the shipped
  // artifact fine, which is the inverse of the failure this launcher exists to prevent.
  net: flags.includes("--allow-net"),
};
const target = (targetAt >= 0 ? flags[targetAt + 1] : "deno") as Target;
if (target !== "deno" && target !== "node") {
  console.error(`unknown target '${target}' — deno or node`);
  Deno.exit(2);
}

const built = await Deno.makeTempFile({ prefix: "wac-app-" });
// The exit code, carried out of the block rather than exited with inside it. `Deno.exit` does not
// run `finally` — so the obvious spelling of this leaked one built executable per invocation, and
// after several thousand runs across the agents sharing this machine that was 1.4GB of /tmp and a
// disk with nothing left on it. The build that then failed reported "No space left on device" from
// `makeTempDir`, which points at the disk rather than at the thing filling it.
let code = 1;
try {
  await buildApp(entry, built, grants, target);
  // Inherited, not piped: the application's output is the point, and `outputSync`
  // would swallow it.
  const stdio = { stdout: "inherit", stderr: "inherit", stdin: "inherit" } as const;
  const cmd = target === "node"
    ? new Deno.Command("node", { args: [built, ...appArgs], ...stdio })
    : new Deno.Command(built, { args: appArgs, ...stdio });

  // Spawned and awaited rather than `outputSync`, so that a signal arriving here can be passed on.
  // `outputSync` blocks the isolate outright: the listeners below would never run, and killing this
  // launcher left the application alive with no handle left to stop it.
  const child = cmd.spawn();
  const forward = (sig: Deno.Signal) => {
    try {
      child.kill(sig);
    } catch {
      // Already gone. A signal racing the child's own exit is the ordinary case, not a problem.
    }
  };
  const onInt = () => forward("SIGINT");
  const onTerm = () => forward("SIGTERM");
  Deno.addSignalListener("SIGINT", onInt);
  Deno.addSignalListener("SIGTERM", onTerm);
  try {
    code = (await child.status).code;
  } finally {
    // Removed, or this process never exits: a signal listener keeps Deno's event loop alive, and the
    // `Deno.exit` below would be reached with two of them still registered.
    Deno.removeSignalListener("SIGINT", onInt);
    Deno.removeSignalListener("SIGTERM", onTerm);
  }
} finally {
  await Deno.remove(built).catch(() => {});
}
Deno.exit(code);
