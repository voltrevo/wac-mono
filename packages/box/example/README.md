# box examples — two browser pages

Whole applications, not snippets. Each is one `.wac` file with no TypeScript beside it: a wac
program on a worker, talking to a capability world on the page's own thread over a
`SharedArrayBuffer`. If you followed a link here from a page on the website, the file you can
build below is byte for byte the file you were looking at.

They live here rather than in `packages/platform/example/` because of which way the imports
point. These reach for `sh`, `crypto` and `gzip`; platform is the package all of those sit on top
of, and a platform example that reached up into a leaf would invert the layering for the sake of a
demonstration.

## Building either of them

You need [Deno](https://deno.com) 2 and this repository. Nothing else — no bundler, no `npm
install`, and no toolchain for wac beyond what is in `../..`.

```sh
git clone https://github.com/voltrevo/wac-mono
cd wac-mono
deno task app:build packages/box/example/hash.wac --target browser -o page/index.html
```

That writes a single self-contained HTML file: the wasm is embedded, and it fetches nothing. You
can open it from a web server, but **not** with `file://`, because a page needs an origin before
it may have a worker.

Serving it needs one unusual thing. The program parks on `Atomics.wait` while the page answers its
calls, so it needs a `SharedArrayBuffer`, and a browser only supplies one to a
[cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)
page — two response headers. `box`'s own web server sends them with `-x`:

```sh
deno task app:build packages/box/src/main.wac --allow-read --allow-net -o box
./box httpd -8080 page -x        # -x adds COOP and COEP
```

Any server that sets `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` will do. If you get a page that says
`SharedArrayBuffer is not defined`, that is the headers and nothing else. (The website cannot set
them — GitHub Pages sends what it likes — so it registers a service worker that re-serves each
page with them instead.)

## hash.wac

SHA-256 and DEFLATE keeping up with your typing. Type in the box, or drop a file anywhere on the
page, and it reports the byte count, the code-point count when they differ, the digest, the
compressed size as a percentage, and how long both took.

```sh
deno task app:build packages/box/example/hash.wac --target browser -o page/index.html
```

No grants: it reads no files and opens no sockets, so the built page has no capability to do
either. A file gets in only because you handed it over — `nextFile` returns what the user chose,
and there is deliberately no way for the program to *ask* for a file (a browser only opens a
dialog during a real user gesture, and by the time a request has crossed to the worker and back
that gesture is over — a capability that works when tested by hand and fails in the field is worse
than none).

`download the .gz` hands the compressed bytes back through `offerDownload`. It is a real gzip
container, header and trailer and CRC, so your own `gunzip` will open it — which is the only reason
the byte count above it is worth trusting.

Both algorithms come from packages written for a command line and neither was changed for a
browser: `packages/crypto/src/sha256.wac` and `packages/gzip/src/gzip.wac`. The same `sha256` runs
in `box sha256sum`.

## term.wac

`packages/sh` with a keyboard in front of it: quoting, parameter expansion, command substitution,
arithmetic, pipelines, redirection, `&&`/`||`, `if`/`while`/`for`/`case`, functions, subshells,
globbing, and the built-ins including `cd`, `pwd`, `ls`, `mkdir` and `rm`. Up and Down walk a
64-entry history; `clear` empties the screen.

```sh
deno task app:build packages/box/example/term.wac --target browser \
  --allow-read --allow-write -o page/index.html
```

The two grants are why it has a filesystem at all, and the shebang of a built program is exactly
its grants — so what an artifact may do is answerable with `head -1`. In a browser those grants
reach the [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
rather than a disk, so what you write survives a reload and is visible to nothing outside the tab.
Drop the two flags and the same page builds with no filesystem, and every redirection fails.

Nothing in `packages/sh` was changed for the browser. What it is missing here is what it never
had: `$WACPATH` finds external commands by spawning them, a page cannot spawn, so on this page the
built-ins are all there is. That is a real limit and worth seeing plainly rather than discovering
later.

## The rest of `box`

These two are the browser pages. `box` itself is a single executable with sixty-odd applets in
`../src/applets/` — see [`../README.md`](../README.md).
