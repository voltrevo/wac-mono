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
// isolation, `Atomics.wait` on a real `Worker`, the page's own plumbing — the blob-URL worker,
// the `crossOriginIsolated` check, the `<pre>` that `write` appends to — and, since `Page`
// landed, an interactive application driven by real clicks and real typing.

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

      // An interactive application, driven by real clicks. This is the part no double reaches:
      // delegated listeners surviving a `render`, an event queue feeding a parked worker, and
      // state kept in a local across events because the program is a loop rather than a set of
      // callbacks.
      await buildApp("packages/platform/example/counter.wac", `${dir}/counter.html`, {}, "browser");
      await page.goto(`http://127.0.0.1:${port}/counter.html`, { waitUntil: "load" });
      await page.waitForSelector("#up", { timeout: 30_000 });

      await page.click("#up");
      await page.click("#up");
      await page.click("#up");
      await page.click("#down");
      assertEquals(await page.textContent("#n"), "2", "three up and one down");

      // Typing, which arrives as `input` events carrying the value.
      await page.fill("#echo", "typed");
      assertEquals(await page.textContent("#said"), "you typed: typed");

      await page.click("#reset");
      assertEquals(await page.textContent("#n"), "0", "reset");
      assertEquals(await page.inputValue("#echo"), "", "reset clears the box too");

      // And the loop ends when the program decides to return, not when the page decides.
      await page.click("#up");
      await page.click("#quit");
      await page.waitForFunction(
        "document.body.innerText.includes('[exit')",
        null,
        { timeout: 30_000 },
      );
      const done = (await page.evaluate("document.body.innerText")) as string;
      assertEquals(done.includes("counted to 1"), true, done);
      assertEquals(done.includes("[exit 0]"), true, done);

      // Pixels, a pointer and files — the three that only a browser can answer for.
      await buildApp("packages/platform/example/pixels.wac", `${dir}/pixels.html`, {}, "browser");
      await page.goto(`http://127.0.0.1:${port}/pixels.html`, { waitUntil: "load" });
      // Wait for the canvas to have been *drawn into*, which is the actual precondition, rather
      // than for a particular size. Two wrong versions preceded this: pinning `width === 240`
      // failed as a timeout when the picture was made bigger, and `width > 0` passed instantly
      // because an undrawn canvas is already 300x150 by default — so the pixel checks below ran
      // on a blank one and reported zero opaque pixels out of 45,000.
      await page.waitForFunction(
        `(() => {
          const c = document.getElementById("c");
          if (c === null) return false;
          const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
          for (let i = 3; i < d.length; i += 4) if (d[i] === 255) return true;
          return false;
        })()`,
        null,
        { timeout: 30_000 },
      );
      const size = await page.evaluate(
        "({ w: document.getElementById('c').width, h: document.getElementById('c').height })",
      ) as { w: number; h: number };

      // A canvas with real content: every pixel opaque, and more than a handful of colours.
      // A blank buffer would satisfy "a canvas exists" and nothing else here.
      const drawn = await page.evaluate(`(() => {
        const c = document.getElementById('c');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const seen = new Set();
        let opaque = 0;
        for (let i = 0; i < d.length; i += 4) {
          seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
          if (d[i + 3] === 255) opaque++;
        }
        return { colours: seen.size, opaque, total: d.length / 4 };
      })()`) as { colours: number; opaque: number; total: number };
      assertEquals(drawn.total, size.w * size.h, "the buffer is the size wac asked for");
      assertEquals(drawn.opaque, drawn.total, "every pixel was written");
      assertEquals(drawn.colours > 20, true, `only ${drawn.colours} colours — is it blank?`);

      // Pointer coordinates, in the canvas's *backing store* — not its CSS box. This canvas is
      // drawn at one size and displayed at another, so the two differ, and the invariant worth
      // asserting is the one an application depends on: the middle of the element is the middle
      // of the buffer it drew. Pinning a literal (it was `x=119`) tested the window size.
      const box = (await page.locator("#c").boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForFunction(
        "document.getElementById('pos').textContent.startsWith('x=')",
        null,
        { timeout: 30_000 },
      );
      const pos = (await page.textContent("#pos")) ?? "";
      const at = pos.match(/x=(\d+) y=(\d+)/);
      assertEquals(at !== null, true, pos);
      assertEquals(
        Math.abs(Number(at![1]) - size.w / 2) <= 3 && Math.abs(Number(at![2]) - size.h / 2) <= 3,
        true,
        `the centre of the element should be the centre of the ${size.w}x${size.h} buffer: ${pos}`,
      );
      // And the centre of the default view is inside the set, so it never escapes.
      assertEquals(pos.includes("never (inside)"), true, pos);

      // A file in and a file back out, checked against this runtime's own crypto and gzip rather
      // than against more wac. It drives `box/example/hash.wac`, which is where `nextFile` lives
      // now: a page that hashes a file you drop on it has a reason to want one, and a Mandelbrot
      // viewer never did.
      await buildApp(
        "packages/box/example/hash.wac",
        `${dir}/hash.html`,
        {},
        "browser",
      );
      await page.goto(`http://127.0.0.1:${port}/hash.html`, { waitUntil: "load" });
      await page.waitForSelector("#in", { timeout: 30_000 });

      const given = `${dir}/given.txt`;
      const body = "handed to the page\n".repeat(500);
      await Deno.writeTextFile(given, body);
      const wanted = [...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
      )].map((b) => b.toString(16).padStart(2, "0")).join("");

      await page.setInputFiles("#f", given);
      await page.waitForFunction(
        "document.getElementById('note').textContent.startsWith('from ')",
        null,
        { timeout: 30_000 },
      );
      assertEquals(await page.textContent("#sha"), wanted, "the page's SHA-256 of the file");
      assertEquals(await page.textContent("#len"), String(body.length));

      const coming = page.waitForEvent("download", { timeout: 30_000 });
      await page.click("#save");
      const back = await coming;
      assertEquals(back.suggestedFilename(), "given.txt.gz");
      // Decompressed by the runtime, so the claim is "a real gzip container" and not "our gzip
      // agrees with our gunzip" — the two ends of a round trip running the same code test only
      // that the code is symmetrical.
      const gz = await Deno.readFile((await back.path())!);
      const plain = new Response(
        new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")),
      );
      assertEquals(await plain.text(), body, "what the page compressed, ungzipped");

      // And the shell, which is `packages/sh` unchanged with a keyboard in front of it.
      await buildApp(
        "packages/box/example/term.wac",
        `${dir}/term.html`,
        { read: true, write: true },
        "browser",
      );
      await page.goto(`http://127.0.0.1:${port}/term.html`, { waitUntil: "load" });
      await page.waitForSelector("#cmd", { timeout: 30_000 });
      const command = async (line: string): Promise<string> => {
        const before = (await page.textContent("#scr")) ?? "";
        await page.fill("#cmd", line);
        await page.press("#cmd", "Enter");
        await page.waitForFunction(
          `document.getElementById('scr').textContent !== ${JSON.stringify(before)}`,
          null,
          { timeout: 30_000 },
        );
        return ((await page.textContent("#scr")) ?? "").slice(before.length).trim();
      };
      assertEquals((await command("echo hello | tr a-z A-Z")).endsWith("HELLO"), true);
      assertEquals((await command("for i in 1 2 3; do echo $i; done")).endsWith("1\n2\n3"), true);
      // Redirection into OPFS and back out again: a shell with a real filesystem under it.
      assertEquals((await command("echo kept > note.txt; cat note.txt")).endsWith("kept"), true);

      // A page spawning a program of its own: issue 0030's whole claim, in a real browser.
      //
      // The child is a `--worker` bundle built for the browser, put into the Origin Private File
      // System by this test — because that is the honest gap 0030 names. A page has no filesystem
      // full of programs, so somebody has to put one there, and once it is there `spawn` reads it
      // like any other file. What this proves that the double cannot: a worker created *by a
      // worker*, its own `SharedArrayBuffer`, and its calls answered by the page while its parent is
      // parked in `Atomics.wait`.
      const childBundle = await Deno.makeTempFile({ prefix: "wac-child-", suffix: ".worker.js" });
      await buildApp("packages/platform/example/wc.wac", childBundle, {}, "browser", true);
      await buildApp(
        "packages/platform/example/runner.wac",
        `${dir}/runner.html`,
        { read: true },
        "browser",
      );
      const bundleSource = await Deno.readTextFile(childBundle);
      await Deno.remove(childBundle);

      // Written straight into OPFS from the page's own thread, which is the only way in: there is
      // no other route to a page's private filesystem, and that is the point of it.
      await page.goto(`http://127.0.0.1:${port}/runner.html`, { waitUntil: "load" });
      await page.evaluate(
        `(async (source) => {
          const root = await navigator.storage.getDirectory();
          const handle = await root.getFileHandle("wc.worker.js", { create: true });
          const w = await handle.createWritable();
          await w.write(source);
          await w.close();
        })(${JSON.stringify(bundleSource)})`,
      );

      await page.goto(
        `http://127.0.0.1:${port}/runner.html?a=wc.worker.js&a=${encodeURIComponent("one two three")}`,
        { waitUntil: "load" },
      );
      await page.waitForFunction(
        "document.body.innerText.includes('[exit')",
        null,
        { timeout: 30_000 },
      );
      const spawned = (await page.evaluate("document.body.innerText")) as string;
      // `wc` of "one two three\n": one line, three words, fourteen bytes. Compared against the same
      // program run natively rather than against a literal, which is the differential this file is
      // for — the child is the same source built for a different host.
      const nativeWc = new Deno.Command(native, {
        args: [],
        stdin: "piped",
        stdout: "piped",
      }).spawn();
      const wr = nativeWc.stdin.getWriter();
      await wr.write(new TextEncoder().encode("one two three\n"));
      await wr.close();
      const nativeOut = new TextDecoder().decode((await nativeWc.output()).stdout).trim();
      assertEquals(spawned.includes(nativeOut), true, `page: ${spawned}\nnative: ${nativeOut}`);
      assertEquals(spawned.includes("[exit 0]"), true, spawned);

      // And the same page running *itself* as a child, which is the half of 0030 that matters for a
      // browser: there is no filesystem of programs in a tab, so the only program a page reliably has
      // is the one it already is. No file was written for this one — that is the whole point.
      await buildApp("packages/platform/example/twin.wac", `${dir}/twin.html`, {}, "browser");
      const twin = await run("twin.html");
      assertEquals(twin.includes("parent: about to run myself"), true, twin);
      assertEquals(twin.includes("SHOUT: HELLO TWIN"), true, twin);
      assertEquals(twin.includes("parent: the child exited 0"), true, twin);
      assertEquals(twin.includes("[exit 0]"), true, twin);

      assertEquals(failures.join("\n"), "", "the page raised errors");
    } finally {
      await browser?.close();
      await http?.stop();
      await Deno.remove(dir, { recursive: true });
      await Deno.remove(native);
    }
  },
});
