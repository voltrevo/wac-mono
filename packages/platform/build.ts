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
  if (g.net) flags.push("--allow-net");
  if (g.env) flags.push("--allow-env");
  return `#!/usr/bin/env -S deno run${flags.length ? " " + flags.join(" ") : ""}\n`;
}

export type Grants = { read?: boolean; write?: boolean; env?: boolean; net?: boolean };

/**
 * Node's `net`, given the promise shape the world expects.
 *
 * Emitted into the launcher only when the network is granted, so a program without it has
 * no `node:net` import at all — the same discipline as everything else here: an ungranted
 * capability is absent rather than refused at the call.
 *
 * Data is queued rather than dropped. A `recv` that has not been called yet must not lose
 * bytes the peer has already sent, so the socket is paused between reads and a waiter is
 * parked only when the queue is empty.
 */
const NODE_NET = `
import * as nodeNetMod from "node:net";

function wrapSock(sock) {
  const queue = [];
  let ended = false;
  let waiting = null;
  const pump = () => {
    if (waiting === null) return;
    if (queue.length > 0) { const w = waiting; waiting = null; w(queue.shift()); return; }
    if (ended) { const w = waiting; waiting = null; w(new Uint8Array(0)); }
  };
  sock.on("data", (c) => { queue.push(new Uint8Array(c)); pump(); });
  sock.on("end", () => { ended = true; pump(); });
  sock.on("close", () => { ended = true; pump(); });
  sock.on("error", () => { ended = true; pump(); });
  return {
    recv: () => new Promise((res) => { waiting = res; pump(); }),
    send: (b) => new Promise((res, rej) => sock.write(b, (e) => (e ? rej(e) : res()))),
    close: () => sock.destroy(),
  };
}

const nodeNet = {
  connect: (host, port) =>
    new Promise((res, rej) => {
      const s = nodeNetMod.createConnection({ host, port }, () => res(wrapSock(s)));
      s.once("error", rej);
    }),
  listen: (port) =>
    new Promise((res) => {
      const pending = [];
      let waiting = null;
      const server = nodeNetMod.createServer((s) => {
        const w = wrapSock(s);
        if (waiting !== null) { const k = waiting; waiting = null; k(w); } else { pending.push(w); }
      });
      server.listen(port, () => res({
        accept: () => new Promise((k) => {
          if (pending.length > 0) { k(pending.shift()); return; }
          waiting = k;
        }),
        close: () => server.close(),
      }));
    }),
};
`;

/** Which runtime the built program is for. */
export type Target = "deno" | "node" | "browser";

/**
 * The page a browser build produces: one file, no server-side templating, nothing fetched.
 *
 * `%LAUNCHER%` is the bundled module. It is inlined rather than linked because the whole
 * point of a built program here is that it is one artefact — the same property `./wc`
 * has under Deno.
 *
 * The page must be served cross-origin isolated or `SharedArrayBuffer` does not exist;
 * `box httpd` does not send those headers, so this says what is needed rather than
 * leaving a bare TypeError. Opening it with `file://` will not work either, for the same
 * reason plus module workers.
 */
const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>%TITLE%</title>
<style>
  body { font: 14px/1.5 ui-monospace, monospace; margin: 2rem; max-width: 60rem; }
  pre { white-space: pre-wrap; word-break: break-word; }
  .warn { color: #b00; }
  .meta { color: #666; }
</style>
<h1>%TITLE%</h1>
<p class="meta">Arguments come from the query string: <code>?a=first&amp;a=second</code>.</p>
<pre id="out"></pre>
<script type="module">
%LAUNCHER%
</script>
`;

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
    const browserRuntime = import.meta.resolve("./host/entryBrowser.ts");
    const nodeRuntime = import.meta.resolve("./host/entryNode.ts");
    const workerSource = target === "browser"
      ? await bundle(
        "worker",
        `import { runAsWorkerBrowser } from "${browserRuntime}";\n` +
          // The application is imported *lazily*, so the message handler is installed
          // before anything can await. See the note above.
          `runAsWorkerBrowser(() => import("${modPath}").then((m) =>\n` +
          `  m as unknown as Parameters<Parameters<typeof runAsWorkerBrowser>[0]>[0]));\n`,
      )
      : target === "node"
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

    const launcher = target === "browser"
      ? await bundle(
        "launcher",
        `import { argsFromLocation, runInPage } from "${browserRuntime}";\n` +
          `const out = document.getElementById("out");\n` +
          `const line = (t, cls) => {\n` +
          `  const s = document.createElement("span");\n` +
          `  if (cls) s.className = cls;\n` +
          `  s.textContent = t + "\\n";\n` +
          `  out.appendChild(s);\n` +
          `};\n` +
          // A page has no stdout, so `write` appends its bytes as text. Exactly the bytes,
          // with no newline of its own — which is what the capability promises.
          `const raw = (b) => {\n` +
          `  const s = document.createElement("span");\n` +
          `  s.textContent = new TextDecoder().decode(b);\n` +
          `  out.appendChild(s);\n` +
          `};\n` +
          `try {\n` +
          (grants.read === true
            ? `  const root = await navigator.storage.getDirectory();\n`
            : `  const root = undefined;\n`) +
          `  const code = await runInPage({\n` +
          `    workerSource: ${JSON.stringify(workerSource)},\n` +
          `    args: argsFromLocation(location.search),\n` +
          `    log: (l) => line(l),\n` +
          `    warn: (l) => line(l, "warn"),\n` +
          `    write: raw,\n` +
          `    root,\n` +
          `    writable: ${grants.write === true},\n` +
          `  });\n` +
          `  line("[exit " + code + "]", "meta");\n` +
          `} catch (e) {\n` +
          `  line(String(e && e.message ? e.message : e), "warn");\n` +
          `}\n`,
      )
      : target === "node"
      ? await bundle(
        "launcher",
        (grants.net === true ? NODE_NET : "") +
          `import { runLauncherNode } from "${nodeRuntime}";\n` +
          `import * as wt from "node:worker_threads";\n` +
          `import { readFile, writeFile, stat, readdir, mkdir, rm, rename, open } from "node:fs/promises";\n` +
          `await runLauncherNode(\n` +
          `  wt as unknown as Parameters<typeof runLauncherNode>[0],\n` +
          `  { readFile, writeFile, stat, readdir, mkdir, rm, rename, open } as unknown as Parameters<typeof runLauncherNode>[1],\n` +
          `  process as unknown as Parameters<typeof runLauncherNode>[2],\n` +
          `  ${JSON.stringify(workerSource)},\n` +
          `  ${JSON.stringify(grants)},\n` +
          (grants.net === true ? `  nodeNet,\n` : ``) +
          `);\n`,
      )
      : await bundle(
        "launcher",
        `import { runLauncher } from "${runtime}";\n` +
          `await runLauncher(${JSON.stringify(workerSource)}, ${JSON.stringify(grants)});\n`,
      );

    if (target === "browser") {
      // A page, not an executable: no shebang and no execute bit.
      const title = entry.split("/").pop() ?? "wac";
      await Deno.writeTextFile(out, PAGE.replaceAll("%TITLE%", title).replace("%LAUNCHER%", launcher));
      return;
    }
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
        "[--allow-read] [--allow-write] [--allow-env] [--allow-net]\n" +
      "                        [--target deno|node|browser]\n\n" +
        "The grants are baked in: the built program takes no permission flags of its own,\n" +
        "and every argument it is given goes to the application.",
    );
    Deno.exit(2);
  }
  const grants: Grants = {
    read: argv.includes("--allow-read"),
    write: argv.includes("--allow-write"),
    net: argv.includes("--allow-net"),
    env: argv.includes("--allow-env"),
  };
  const ti = argv.indexOf("--target");
  const target = (ti >= 0 ? argv[ti + 1] : "deno") as Target;
  if (target !== "deno" && target !== "node" && target !== "browser") {
    console.error(`unknown target '${target}' — deno, node or browser`);
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
