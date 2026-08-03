// The two halves of a built program, in a page.
//
// Same bridge, same opcodes, same capability structs. What differs from Deno and Node is
// smaller than it looks: the worker is a web `Worker` from a blob URL, and the page checks
// `crossOriginIsolated` before doing anything, because without it `SharedArrayBuffer` is
// not constructible and the failure would otherwise be a bare TypeError from `newBridge`.
//
// The worker half is unchanged in shape from Deno's: a message brings the buffer, the
// application runs to completion on a thread that is allowed to block, and the result goes
// back. `Atomics.wait` throws on a page's main thread, which is exactly why the split
// exists and why the page must not be the one running wac.

import { bridgeOf, newBridge } from "./layout.ts";
import { serveHostCalls } from "./respond.ts";
import { browserWorld, type BrowserWorldOptions, type Dom } from "./browser.ts";
import { cliOf, coreOf, type PageClasses, pageOf } from "./provider.ts";
import type { AppModule } from "./entry.ts";

type Start = { sab: SharedArrayBuffer };
type Result = { ok: true; code: number } | { ok: false; error: string };

/**
 * The worker half. Call this at module scope, before awaiting anything.
 *
 * The handler has to be installed synchronously: a generated program suspends at its own
 * top-level `await WebAssembly.instantiate`, and a `postMessage` that arrives during that
 * suspension is dropped. `packages/stream`'s README records the same trap, and the Deno
 * launcher was bitten by it once — it worked one run in three.
 */
export function runAsWorkerBrowser(load: () => Promise<AppModule>): void {
  // `self` is a worker scope here, which Deno's default library does not know while
  // type-checking this file — the same cast `entry.ts` makes, for the same reason.
  const scope = self as unknown as {
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage(m: Result): void;
  };
  scope.onmessage = (ev: MessageEvent) => {
    const start = ev.data as Start;
    void (async () => {
      const b = bridgeOf(start.sab);
      try {
        const app = await load();
        // A module with a `page` export is an interactive application, and gets `Page`
        // instead of `Cli`. Chosen by which export exists rather than by inspecting `main`'s
        // parameter types: the name says which kind of program this is, at a glance, in the
        // source and here.
        // An interactive application gets all three profiles, not two. A page has a
        // filesystem and arguments like any other program — `packages/sh` in a terminal needs
        // `Cli` to be a shell at all — and withholding it would have meant a second way to ask
        // for the same things.
        const code = app.page !== undefined
          ? app.page(coreOf(b, app), cliOf(b, app), pageOf(b, app as unknown as PageClasses))
          : app.main(coreOf(b, app), cliOf(b, app));
        scope.postMessage({ ok: true, code });
      } catch (e) {
        scope.postMessage({
          ok: false,
          error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e),
        });
      }
    })();
  };
}

/**
 * The little of the DOM this needs, declared here rather than by pulling in a whole library.
 *
 * Deno's default types do not describe a document, and the alternative — a `lib.dom` reference
 * — would put every browser global in scope for a file that runs under Deno's type checker.
 * Structural types keep the surface honest: these six members are precisely what is used.
 */
type El = {
  id: string;
  innerHTML: string;
  textContent: string | null;
  value?: string;
  width?: number;
  height?: number;
  files?: { length: number; item(i: number): FileLike | null };
  closest(selector: string): El | null;
  getBoundingClientRect?(): { width: number; height: number };
  getContext?(kind: string): Ctx | null;
  addEventListener(kind: string, fn: (ev: Ev) => void): void;
};
type FileLike = { name: string; arrayBuffer(): Promise<ArrayBuffer> };
type Ctx = {
  putImageData(data: ImageDataLike, x: number, y: number): void;
  createImageData(w: number, h: number): ImageDataLike;
};
type ImageDataLike = { data: { set(src: Uint8Array, at?: number): void } };
type Ev = {
  target: El | null;
  key?: string;
  offsetX?: number;
  offsetY?: number;
  dataTransfer?: { files: { length: number; item(i: number): FileLike | null } };
  preventDefault(): void;
};
type Doc = {
  title: string;
  getElementById(id: string): El | null;
  addEventListener(kind: string, fn: (ev: Ev) => void): void;
};

/**
 * The document, as the small string-shaped thing `browser.ts` asks for.
 *
 * Here rather than in `browser.ts` so that module names no browser global and can be tested
 * against a double — the same split as the Origin Private File System root.
 *
 * Events are **delegated from the document**: one listener per kind, and `closest(selector)`
 * decides whether a given event is one the application asked for. Listeners attached to the
 * matching elements themselves would stop working the moment `render` replaced them, and the
 * symptom — the first click works and the second does not — sends you looking in the wrong
 * place entirely.
 */
export function pageDom(root: El, doc: Doc, make: MakeDownload): Dom {
  type PageEvent = { kind: string; id: string; value: string; x: number; y: number };
  type PickedFile = { ok: boolean; name: string; bytes: Uint8Array; error: string };

  const queue: PageEvent[] = [];
  let waiting: ((e: PageEvent) => void) | null = null;
  const wanted = new Map<string, string[]>();   // event kind -> the selectors asked for

  // Files arrive whether or not the application has asked yet, so they queue like events. The
  // listeners below are attached once and unconditionally: a file the user has already dropped
  // must not be lost because the program had not got to `nextFile` yet.
  const files: PickedFile[] = [];
  let wantsFile: ((f: PickedFile) => void) | null = null;
  const gotFile = (f: PickedFile) => {
    if (wantsFile !== null) {
      const w = wantsFile;
      wantsFile = null;
      w(f);
      return;
    }
    files.push(f);
  };
  const takeFiles = (list: { length: number; item(i: number): FileLike | null } | undefined) => {
    for (let i = 0; i < (list?.length ?? 0); i++) {
      const f = list?.item(i);
      if (f == null) continue;
      // Read here rather than handing the application a handle: a `File` is a live object on
      // this thread, and everything across the bridge is bytes.
      f.arrayBuffer()
        .then((buf) => gotFile({ ok: true, name: f.name, bytes: new Uint8Array(buf), error: "" }))
        .catch((e) =>
          gotFile({ ok: false, name: f.name, bytes: new Uint8Array(0), error: String(e?.message ?? e) })
        );
    }
  };
  doc.addEventListener("change", (ev: Ev) => takeFiles(ev.target?.files));
  // Dropping needs both: without `dragover` being prevented the browser navigates to the file
  // instead, which unloads the application mid-run and looks like a crash.
  doc.addEventListener("dragover", (ev: Ev) => ev.preventDefault());
  doc.addEventListener("drop", (ev: Ev) => {
    ev.preventDefault();
    takeFiles(ev.dataTransfer?.files);
  });

  const deliver = (e: PageEvent) => {
    if (waiting !== null) {
      const w = waiting;
      waiting = null;
      w(e);
      return;
    }
    queue.push(e);
  };

  return {
    render: (html) => { root.innerHTML = html; },
    setText: (id, text) => {
      const el = doc.getElementById(id);
      if (el !== null) el.textContent = text;
    },
    setValue: (id, value) => {
      const el = doc.getElementById(id);
      if (el !== null) el.value = value;
    },
    value: (id) => doc.getElementById(id)?.value ?? "",
    title: (text) => { doc.title = text; },
    on: (selector, kind) => {
      const already = wanted.get(kind);
      if (already !== undefined) {
        already.push(selector);
        return;   // one listener per kind; the selector list grows instead
      }
      wanted.set(kind, [selector]);
      doc.addEventListener(kind, (ev: Ev) => {
        const target = ev.target;
        if (target === null) return;
        for (const sel of wanted.get(kind) ?? []) {
          const hit = target.closest(sel);
          if (hit === null) continue;
          // A form's `submit` would reload the page, which ends the application mid-answer.
          if (kind === "submit") ev.preventDefault();
          // `offsetX` is in CSS pixels of the element. For a canvas that is not what the
          // application drew into: a `<canvas width="480">` shown at `width: 100%` reports 0..504
          // on a wide screen and 0..320 on a phone, while the buffer is always 480 across. The
          // capability promises the element's *own* pixels, so a canvas gets scaled to its
          // backing store — without this, click-to-zoom landed near where you clicked at one
          // window size and visibly wrong at every other, which is the worst kind of nearly.
          const rect = target.getBoundingClientRect?.();
          const sx = target.width !== undefined && rect !== undefined && rect.width > 0
            ? target.width / rect.width
            : 1;
          const sy = target.height !== undefined && rect !== undefined && rect.height > 0
            ? target.height / rect.height
            : 1;
          deliver({
            kind,
            id: hit.id,
            value: kind === "keydown" ? (ev.key ?? "") : (target.value ?? ""),
            x: Math.round((ev.offsetX ?? 0) * sx),
            y: Math.round((ev.offsetY ?? 0) * sy),
          });
          return;
        }
      });
    },
    next: () =>
      new Promise((resolve) => {
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        // One waiter, because there is one worker asking. A second `nextEvent` before the
        // first is answered would be the application's bug rather than something to buffer.
        waiting = resolve;
      }),
    drawPixels: (id, w, h, rgba) => {
      const el = doc.getElementById(id);
      const ctx = el?.getContext?.("2d");
      if (el === null || el === undefined || ctx == null) {
        throw new Error(`drawPixels: no canvas with id ${JSON.stringify(id)}`);
      }
      // Resizing clears the canvas, so it is done before the blit and only when it changes —
      // setting width every frame would flicker and cost a reallocation per frame.
      if (el.width !== w) el.width = w;
      if (el.height !== h) el.height = h;
      const img = ctx.createImageData(w, h);
      img.data.set(rgba);
      ctx.putImageData(img, 0, 0);
    },
    nextFile: () =>
      new Promise((resolve) => {
        const queued = files.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        wantsFile = resolve;
      }),
    offerDownload: (name, bytes) => make(name, bytes),
  };
}

/**
 * How a page hands bytes back to the user.
 *
 * A parameter rather than code here because it is the one thing in this file that needs
 * `Blob`, `URL` and an anchor, and passing it in keeps `pageDom` testable without any of them.
 */
export type MakeDownload = (name: string, bytes: Uint8Array) => void;

/** What a page needs to say about the environment it is offering. */
export type PageOptions = BrowserWorldOptions & {
  /** The worker's source. The build inlines the whole program here. */
  workerSource: string;
};

/**
 * The launcher half: serve capabilities on the page's thread, run the worker, resolve with
 * the application's exit code.
 *
 * Never blocks. `serveHostCalls` waits with `Atomics.waitAsync`, so the event loop keeps
 * turning and the asynchronous work a capability needs — an OPFS read, say — can actually
 * happen while the worker is parked waiting for it.
 */
export async function runInPage(opts: PageOptions): Promise<number> {
  // Another one Deno's library does not declare, because it is a page property.
  const isolated = (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  if (isolated !== true) {
    throw new Error(
      "this page is not cross-origin isolated, so SharedArrayBuffer is unavailable — " +
        "serve it with Cross-Origin-Opener-Policy: same-origin and " +
        "Cross-Origin-Embedder-Policy: require-corp",
    );
  }

  const bridge = newBridge();
  const responder = serveHostCalls(bridge, browserWorld(opts));

  const url = URL.createObjectURL(new Blob([opts.workerSource], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "module" });
  try {
    const code = await new Promise<number>((resolve, reject) => {
      worker.addEventListener("message", (ev: MessageEvent) => {
        const r = ev.data as Result;
        if (r.ok) resolve(r.code);
        else reject(new Error(r.error));
      });
      worker.addEventListener("error", (e: ErrorEvent) => reject(new Error(e.message)));
      worker.postMessage({ sab: bridge.sab } as Start);
    });
    return code;
  } finally {
    responder.stop();
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}

/** Arguments from the query string: `?a=one&a=two` becomes `["one", "two"]`. */
export function argsFromLocation(search: string): string[] {
  return new URLSearchParams(search).getAll("a");
}
