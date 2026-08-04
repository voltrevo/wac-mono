# platform examples — whole programs, in one file each

A wac program is a function that takes the world as parameters. There is no `extern`, no
declaration form, no way to write the name of a function that lives outside the program — so the
only host code a module can call is a value someone handed it, and a whole application is
`main(Core core, Cli cli)` or `page(Core core, Cli cli, Page page)`.

Everything here is one `.wac` file with no TypeScript beside it. If you followed a link here from a
page on the website, the file you can build below is byte for byte the file you were looking at.

## Building any of them

You need [Deno](https://deno.com) 2 and this repository. Nothing else.

```sh
git clone https://github.com/voltrevo/wac-mono
cd wac-mono
deno task app packages/platform/example/wc.wac --allow-read -- README.md   # build and run
deno task app:build packages/platform/example/wc.wac --allow-read -o wc    # keep the artifact
```

`app:build` writes one self-contained executable — the wasm is embedded and it fetches nothing.
**Permissions are decided when it is built, not when it is run**: the built program takes no
permission flags of its own and passes every argument to the application, so whoever packages it
chooses what it may do and whoever runs it cannot widen that. The shebang is exactly the grants:

```sh
head -1 wc      # #!/usr/bin/env -S deno run --allow-read
```

A program given no grants has no capability to read a file, and a module that takes no `fn[…]`
parameter has no wasm imports at all — not "none that it uses", none in the binary.

### The two that build for a browser

`counter.wac` and `pixels.wac` export `page` instead of `main`, and want `--target browser`:

```sh
deno task app:build packages/platform/example/pixels.wac --target browser -o page/index.html
```

That writes a single HTML file. Serve it — `file://` will not do, because a page needs an origin
before it may have a worker — and serve it *cross-origin isolated*, because the program parks on
`Atomics.wait` while the page answers its calls and a browser only gives a `SharedArrayBuffer` to
an isolated page. `box`'s web server does it with `-x`:

```sh
deno task app:build packages/box/src/main.wac --allow-read --allow-net -o box
./box httpd -8080 page -x        # -x adds COOP and COEP
```

Any server sending `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` will do. `SharedArrayBuffer is not defined` means
those two headers and nothing else.

## pixels.wac

A Mandelbrot set: 38400 pixels, each an iteration loop, all of it fixed-point `i32`, recomputed
from scratch on every zoom while the page stays responsive. Click the picture to centre there and
halve the view; the escape count under the pointer is displayed as you move.

```sh
deno task app:build packages/platform/example/pixels.wac --target browser -o page/index.html
```

No grants — it reads nothing and opens nothing. Three capabilities carry the whole application:

- `drawPixels` blits a buffer wac filled. A drawing API would have made this the slow way to do
  it; one call with 38400 finished pixels is the fast way.
- `Event.x` / `Event.y` say where in *that buffer* the pointer is, scaled from the element by the
  host. Without them the only zoom possible is the middle of the picture, which is the least
  interesting part of any fractal — and the escape count on screen is what proves the scaling,
  since an off-by-a-scroll shows up there at once.
- `offerDownload` hands the frame back as a [PPM](https://netpbm.sourceforge.net/doc/ppm.html) —
  a format whose entire header is three lines of ASCII, so the file is written by the same
  fixed-point loop that drew the screen.

It used to accept a dropped file as well, and hand it straight back as `.copy`. That was coverage
wearing a demonstration's clothes: `nextFile` arrived in the same commit as the raster
capabilities and this was the page that happened to have a `Page` profile plumbed. A fractal viewer
has no use for a file you give it. It lives in
[`box/example/hash.wac`](../../box/example/README.md#hashwac) now, where a dropped file is the
first thing anyone reaches for.

## The others

Each is here because it is the smallest program that exercises one thing.

| file | what it is for |
| --- | --- |
| `wc.wac` | a complete application, and the one to read first |
| `counter.wac` | the smallest interactive page: draw, then answer what the user does |
| `hexdump.wac` | a filter — standard input, and standard output that is not a log |
| `roundtrip.wac` | the filesystem, wherever it happens to be (a disk, or the browser's OPFS) |
| `overlap.wac` | two reads in flight at once, which is what the ticket surface is *for* |
| `whichever.wac` | `waitAny` over two sockets: the shape `nc`, an SSH relay and a shell all need |
| `patience.wac` | bounding how long a call may take, and what happens when it expires |
| `runner.wac` | running another wac program as a worker, feeding it, reading it back |
| `pipe.wac` | two programs piped together with no shell involved |
| `inetd.wac` | a network service whose per-connection handler is another wac program |
| `probe.wac` | reports what it is allowed to do — for checking what a spawned child was granted |

The ones that spawn (`runner`, `pipe`, `inetd`) are Deno-only: a page cannot spawn. A child gets
the grants its parent chose intersected with what the parent itself holds, so a program can hand
out one capability and can never hand out one it lacks — `probe.wac` is how that is checked.

See [`../README.md`](../README.md) for the capability world itself, and `../src/platform.wac` for
the whole surface in one file.
