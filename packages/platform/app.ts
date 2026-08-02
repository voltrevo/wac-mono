// Run a wac application from the command line.
//
//   deno task app <entry.wac> [--allow-read] [--allow-write] [--allow-env] [-- args...]
//
// Permissions are named here rather than inherited, because the capability world is the
// point: an application gets a filesystem only if this command line says so, and the
// application cannot tell a withheld capability from a broken one.

import { runApp } from "./host/launch.ts";

const argv = [...Deno.args];
const sep = argv.indexOf("--");
const flags = sep < 0 ? argv : argv.slice(0, sep);
const appArgs = sep < 0 ? [] : argv.slice(sep + 1);

const entry = flags.find((a) => !a.startsWith("-"));
if (entry === undefined) {
  console.error(
    "usage: deno task app <entry.wac> [--allow-read] [--allow-write] [--allow-env] [-- args...]",
  );
  Deno.exit(2);
}

const has = (f: string) => flags.includes(f);
const code = await runApp(entry, {
  args: appArgs,
  fs: { read: has("--allow-read"), write: has("--allow-write") },
  env: has("--allow-env") ? (n) => Deno.env.get(n) : undefined,
});
Deno.exit(code);
