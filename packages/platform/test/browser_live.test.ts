// The browser target, in an actual browser. wac-mono issue 0016.
//
// `browser.test.ts` drives the handlers over an in-memory Origin Private File System, which is
// most of the value and not all of it: `readDir(".")` passed there for a week and answered "not
// a directory" in Chromium, because the double's path handling came from the same assumption as
// the code it was checking. A double cannot find that. A browser can.
//
// **Ignored unless a browser is installed**, so the suite stays zero-dependency and offline by
// default: the `npm:playwright` import is dynamic and inside the test, so nothing is fetched
// when it is skipped. To make it run:
//
//     mkdir -p ~/pw && cd ~/pw && npm install playwright
//     ./node_modules/.bin/playwright install chromium
//     sudo ./node_modules/.bin/playwright install-deps chromium
//
// The browser lands in `~/.cache/ms-playwright`, which is what the guard looks for. Deno pulls
// the JavaScript half itself on first run. Then run it with `deno test -A` — `deno task test`
// withholds `--allow-sys`, which Playwright needs, and the guard skips rather than fails. Chromium 151 on arm64 works — issue 0016 warned the
// arm64 builds had been unavailable, and they are not any more.
//
// What this proves that nothing else does: `SharedArrayBuffer` under genuine cross-origin
// isolation, `Atomics.wait` on a real `Worker`, and the page's own plumbing — the blob-URL
// worker, the `crossOriginIsolated` check, and the `<pre>` that `write` appends to.

import { buildApp } from "../build.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/**
 * Whether this run can drive a browser at all: one has to be installed, and Playwright needs
 * a permission the shared suite does not grant.
 *
 * `deno task test` runs with read, write, run, net and env — not `--allow-sys`, which
 * `playwright-core` needs at *import* time to work out where Chrome keeps its profile. Rather
 * than widen the permissions of every test in the repo for one that is usually skipped, this
 * asks, and the answer decides. So the live test runs under `deno test -A` and is ignored by
 * `deno task test`, which is the right way round: the shared suite should not be the thing
 * that needs a browser.
 */
function canDriveBrowser(): boolean {
  if (Deno.permissions.querySync({ name: "sys", kind: "homedir" }).state !== "granted") {
    return false;
  }
  const home = Deno.env.get("HOME");
  if (home === undefined) return false;
  try {
    return [...Deno.readDirSync(`${home}/.cache/ms-playwright`)]
      .some((e) => e.isDirectory && e.name.startsWith("chromium"));
  } catch {
    return false;   // no such directory: no browser
  }
}

/**
 * Serve a directory with the two headers a page needs before `SharedArrayBuffer` exists.
 *
 * `box httpd -x` sends exactly these and would make the loop entirely wac, which is a better
 * demonstration than a test: platform's own suite should not need `box` built to run.
 */
function serve(dir: string): { port: number; stop(): Promise<void> } {
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const name = new URL(req.url).pathname.replace(/^\/+/, "") || "index.html";
    try {
      const body = await Deno.readFile(`${dir}/${name}`);
      return new Response(body, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-embedder-policy": "require-corp",
        },
      });
    } catch {
      return new Response("no", { status: 404 });
    }
  });
  return { port: (server.addr as Deno.NetAddr).port, stop: () => server.shutdown() };
}

Deno.test({
  name: "a wac program runs in a real browser, over real cross-origin isolation",
  ignore: !canDriveBrowser(),
  // An external browser process and its pipes are not resources this test can account for to
  // Deno's satisfaction, and pretending otherwise would mean leaking them instead.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { chromium } = await import("npm:playwright@1");
    const dir = await Deno.makeTempDir({ prefix: "wac-page-" });
    const native = await Deno.makeTempFile({ prefix: "wac-wc-" });
    let browser;
    let http: { port: number; stop(): Promise<void> } | undefined;
    try {
      // `wc` for the browser and for Deno, from one source: the differential is the point.
      await buildApp("packages/platform/example/wc.wac", `${dir}/index.html`, {}, "browser");
      await buildApp("packages/platform/example/wc.wac", native, {});
      // `roundtrip` exercises the filesystem, which is where a page differs most.
      await buildApp(
        "packages/platform/example/roundtrip.wac",
        `${dir}/rt.html`,
        { read: true, write: true },
        "browser",
      );

      const port = (http = serve(dir)).port;
      // --no-proxy-server: this container sets HTTP_PROXY, and Chromium would send 127.0.0.1
      // through Squid, which cannot reach it.
      browser = await chromium.launch({ args: ["--no-proxy-server"] });
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on("pageerror", (e: Error) => failures.push(String(e)));

      const run = async (path: string): Promise<string> => {
        await page.goto(`http://127.0.0.1:${port}/${path}`, { waitUntil: "load" });
        // The exit line is the launcher saying the application returned, so it is the only
        // sound thing to wait for — and a timeout here is a failure, never a pass.
        // Page code as strings, not closures: `document` and `crossOriginIsolated` are not in
        // Deno's type environment, and a closure that only compiles because it was cast is a
        // worse lie than a string that plainly runs somewhere else.
        await page.waitForFunction(
          "document.body.innerText.includes('[exit')",
          null,
          { timeout: 30_000 },
        );
        return (await page.evaluate("document.body.innerText")) as string;
      };

      const wc = await run("index.html");
      // The headers did their job. Without this the rest could pass for the wrong reason —
      // a page that never reached `newBridge` would show its header text and nothing else.
      assertEquals(await page.evaluate("crossOriginIsolated"), true, "cross-origin isolated");
      assertEquals(await page.evaluate("typeof SharedArrayBuffer"), "function", "SharedArrayBuffer");
      assertEquals(wc.includes("[exit 0]"), true, wc);

      // A page's standard input is always empty, so the comparison is `wc` of nothing — which
      // is still the whole bridge: a worker parked on `Atomics.wait` for every capability.
      const onDeno = new Deno.Command(native, { stdin: "null", stdout: "piped" }).outputSync();
      const expected = new TextDecoder().decode(onDeno.stdout).trim();
      assertEquals(wc.includes(expected), true, `page should contain ${expected}:\n${wc}`);

      // The filesystem. `readDir(".")` is here because it is what this test was worth writing
      // for: it answered "not a directory" in Chromium while the double said otherwise.
      const rt = await run("rt.html");
      assertEquals(rt.includes("same bytes back"), true, rt);
      assertEquals(rt.includes("including roundtrip.txt"), true, rt);
      assertEquals(rt.includes("[exit 0]"), true, rt);

      assertEquals(failures.join("\n"), "", "the page raised errors");
    } finally {
      await browser?.close();
      await http?.stop();
      await Deno.remove(dir, { recursive: true });
      await Deno.remove(native);
    }
  },
});
