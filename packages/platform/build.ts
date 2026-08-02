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
function shebangFor(g: Grants, target: Target): string {
  // Node has no permission system, so its shebang has nothing to state — the capability
  // world is the whole boundary there. Under Deno the two agree, and a program granted
  // nothing asks for nothing.
  if (target === "node") return "#!/usr/bin/env node\n";
  const flags: string[] = [];
  if (g.read) flags.push("--allow-read");
  if (g.write) flags.push("--allow-write");
  if (g.env) flags.push("--allow-env");
  return `#!/usr/bin/env -S deno run${flags.length ? " " + flags.join(" ") : ""}\n`;
}

export type Grants = { read?: boolean; write?: boolean; env?: boolean };

/** Which runtime the built program is for. */
export type Target = "deno" | "node";

export async function buildApp(
  entry: string,
  out: string,
  grants: Grants = {},
  target: Target = "deno",
): Promise<void> {
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
    const nodeRuntime = import.meta.resolve("./host/entryNode.ts");
    const workerSource = target === "node"
      ? await bundle(
        "worker",
        `import { runAsWorkerEntryNode } from "${nodeRuntime}";\n` +
          `import * as wt from "node:worker_threads";\n` +
          `import * as app from "${modPath}";\n` +
          `runAsWorkerEntryNode(\n` +
          `  wt as unknown as Parameters<typeof runAsWorkerEntryNode>[0],\n` +
          `  app as unknown as Parameters<typeof runAsWorkerEntryNode>[1],\n` +
          `);\n`,
      )
      : await bundle(
        "worker",
        `import { runAsWorkerEntry } from "${runtime}";\n` +
          `import * as app from "${modPath}";\n` +
          `await runAsWorkerEntry(app as unknown as Parameters<typeof runAsWorkerEntry>[0]);\n`,
      );

    const launcher = target === "node"
      ? await bundle(
        "launcher",
        `import { runLauncherNode } from "${nodeRuntime}";\n` +
          `import * as wt from "node:worker_threads";\n` +
          `import { readFile, writeFile, stat, readdir } from "node:fs/promises";\n` +
          `await runLauncherNode(\n` +
          `  wt as unknown as Parameters<typeof runLauncherNode>[0],\n` +
          `  { readFile, writeFile, stat, readdir } as unknown as Parameters<typeof runLauncherNode>[1],\n` +
          `  process as unknown as Parameters<typeof runLauncherNode>[2],\n` +
          `  ${JSON.stringify(workerSource)},\n` +
          `  ${JSON.stringify(grants)},\n` +
          `);\n`,
      )
      : await bundle(
        "launcher",
        `import { runLauncher } from "${runtime}";\n` +
          `await runLauncher(${JSON.stringify(workerSource)}, ${JSON.stringify(grants)});\n`,
      );

    await Deno.writeTextFile(out, shebangFor(grants, target) + launcher);
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
        "[--allow-read] [--allow-write] [--allow-env] [--target deno|node]\n\n" +
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
  const ti = argv.indexOf("--target");
  const target = (ti >= 0 ? argv[ti + 1] : "deno") as Target;
  if (target !== "deno" && target !== "node") {
    console.error(`unknown target '${target}' — deno or node`);
    Deno.exit(2);
  }
  const dest = out ?? entry.replace(/.*\//, "").replace(/\.wac$/, "");
  await buildApp(entry, dest, grants, target);
  const size = (await Deno.stat(dest)).size;
  const granted = Object.entries(grants).filter(([, v]) => v).map(([k]) => k);
  console.log(
    `${dest}  ${(size / 1024).toFixed(0)}K  ${target}  ` +
      `[${granted.join(", ") || "no capabilities"}]`,
  );
}
