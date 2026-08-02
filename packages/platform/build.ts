// Build a wac application into one executable JavaScript file.
//
//   deno task app:build packages/platform/example/wc.wac -o wc
//   ./wc --allow-read -- README.md
//
// The result is self-contained: the wasm is base64 inside it, the bindgen wrappers are
// inside it, and so is the whole host — bridge, worker, capability providers. Nothing is
// read from this repo at run time, so the file can be copied anywhere Deno exists.
//
// The shebang asks for the permissions the *launcher* needs, which are not the ones the
// application gets. Deno must be allowed to read the file it is running and to spawn a
// worker; what the application may do is decided by the flags passed to the file itself.
// A build with `--allow-read` in the shebang still refuses the application a filesystem
// unless it is run with `--allow-read`.

import { wacCompile } from "wac/wacCompile.ts";
import { wacBindgen } from "wac/wacBindgen.ts";
import { wacFiles } from "../../harness/wacFiles.ts";
import { checkWacVersion } from "../../harness/wacVersion.ts";

/**
 * What the built file asks Deno for: exactly the capabilities granted, and nothing else.
 *
 * A program granted nothing asks for nothing. That is only possible because the worker is
 * spawned from a blob URL rather than from the file itself — self-spawning needs
 * `--allow-read`, which used to sit in every shebang whatever the program could do, and
 * read as a filesystem grant to anyone auditing it.
 */
function shebangFor(g: Grants): string {
  const flags: string[] = [];
  if (g.read) flags.push("--allow-read");
  if (g.write) flags.push("--allow-write");
  if (g.env) flags.push("--allow-env");
  return `#!/usr/bin/env -S deno run${flags.length ? " " + flags.join(" ") : ""}\n`;
}

export type Grants = { read?: boolean; write?: boolean; env?: boolean };

export async function buildApp(entry: string, out: string, grants: Grants = {}): Promise<void> {
  checkWacVersion();

  const r = wacCompile(await wacFiles(entry), entry);
  if (!r.ok) {
    throw new Error(
      `${entry} did not compile:\n` +
        r.diagnostics.map((d) => `  ${d.file}:${d.line}:${d.col} ${d.message}`).join("\n"),
    );
  }

  const work = await Deno.makeTempDir({ prefix: "wac-app-" });
  try {
    const modPath = `${work}/app.gen.ts`;
    await Deno.writeTextFile(modPath, wacBindgen(r.compiled));
    const runtime = import.meta.resolve("./host/entry.ts");

    const bundle = async (name: string, source: string): Promise<string> => {
      const src = `${work}/${name}.ts`;
      const dst = `${work}/${name}.js`;
      await Deno.writeTextFile(src, source);
      const res = new Deno.Command(Deno.execPath(), {
        args: ["bundle", "--platform", "deno", "-o", dst, src],
        stdout: "piped",
        stderr: "piped",
      }).outputSync();
      if (!res.success) {
        throw new Error(`deno bundle failed:\n${new TextDecoder().decode(res.stderr)}`);
      }
      return await Deno.readTextFile(dst);
    };

    // Two passes. The worker bundle holds the application and the wasm; the launcher
    // carries it as a string and never contains the wasm itself.
    //
    // The runtime import comes *first* in the worker entry on purpose: it installs the
    // message handler as a side effect of being evaluated, and the application module
    // below it has a top-level await that would otherwise suspend before any handler
    // existed — which showed up as a program that worked one run in three.
    const workerSource = await bundle(
      "worker",
      `import { runAsWorkerEntry } from "${runtime}";\n` +
        `import * as app from "${modPath}";\n` +
        `await runAsWorkerEntry(app as unknown as Parameters<typeof runAsWorkerEntry>[0]);\n`,
    );
    const launcher = await bundle(
      "launcher",
      `import { runLauncher } from "${runtime}";\n` +
        `await runLauncher(${JSON.stringify(workerSource)}, ${JSON.stringify(grants)});\n`,
    );

    await Deno.writeTextFile(out, shebangFor(grants) + launcher);
    await Deno.chmod(out, 0o755);
  } finally {
    await Deno.remove(work, { recursive: true });
  }
}

if (import.meta.main) {
  const argv = [...Deno.args];
  const oi = argv.indexOf("-o");
  const out = oi >= 0 ? argv[oi + 1] : null;
  const entry = argv.find((a, i) => !a.startsWith("-") && i !== oi + 1);
  if (entry === undefined) {
    console.error(
      "usage: deno task app:build <entry.wac> [-o output] " +
        "[--allow-read] [--allow-write] [--allow-env]\n\n" +
        "The grants are baked in: the built program takes no permission flags of its own,\n" +
        "and every argument it is given goes to the application.",
    );
    Deno.exit(2);
  }
  const grants: Grants = {
    read: argv.includes("--allow-read"),
    write: argv.includes("--allow-write"),
    env: argv.includes("--allow-env"),
  };
  const target = out ?? entry.replace(/.*\//, "").replace(/\.wac$/, "");
  await buildApp(entry, target, grants);
  const size = (await Deno.stat(target)).size;
  const granted = Object.entries(grants).filter(([, v]) => v).map(([k]) => k);
  console.log(`${target}  ${(size / 1024).toFixed(0)}K  [${granted.join(", ") || "no capabilities"}]`);
}
