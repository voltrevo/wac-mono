# 0016 — the browser target is untested in a browser; Playwright's CDN is blocked

- **Status:** closed 2026-08-03 — it runs in Chromium 151, and found a bug on the first try
- **Reported by:** agent-a
- **Date:** 2026-08-02
- **Kind:** task
- **Symptom:** not implemented

`packages/platform` builds a browser target (`--target browser`), and its capability
mapping is tested handler by handler in `test/browser.test.ts` over an in-memory Origin
Private File System. **Nothing has ever run in an actual browser**, because there is none
in this container, and the README says so rather than implying otherwise.

What that leaves unverified is narrow but real:

- `SharedArrayBuffer` under genuine cross-origin isolation;
- `Atomics.wait` on a real `Worker` — the thing the whole bridge rests on;
- the page's own plumbing: the blob-URL worker, the `crossOriginIsolated` check, the
  `<pre>` that `write` appends to.

All three are code paths shared verbatim with the Deno and Node targets, which *are*
tested, so the untested part is the part that is not browser-specific. That is an argument
and not a proof.

## What is blocked

One domain. Everything else is in place:

- `registry.npmjs.org` is on the allowlist, so `npm install playwright` works — the
  package installs and loads.
- `cdn.playwright.dev` is **not**, so the browser binary cannot be fetched:

```
https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1234/chromium-linux-arm64.zip
→ 403 from the proxy
```

apt is not an alternative: on Ubuntu 24.04 both `chromium-browser` and `firefox` are snap
transitional packages (`2:1snap1-0ubuntu2`), and this container is arm64, so there is no
third-party `.deb` worth chasing either.

**Ask the operator** to add `cdn.playwright.dev` to
`local/channels/<channel>/allowed_domains.txt` and run
`./channel.sh <channel> reload-gateway`.

Be warned that it may still not work: Playwright's Linux **arm64** Chromium builds have
been intermittently unavailable, and the `1234` revision in that URL looks like a
placeholder from a package that could not reach the CDN to resolve it. A 404 after the
allowlist is a different problem and should be reported as one rather than worked around.

## The test to write

About twenty lines, and it turns the argument into a proof:

1. `deno task app:build packages/platform/example/wc.wac --target browser -o page/index.html`
2. `box httpd -<port> page -x -o` — `-x` sends the two headers a page needs before
   `SharedArrayBuffer` exists, which is exactly why that flag was added.
3. Playwright opens the page with `?a=…`, waits for the `[exit 0]` line, and asserts the
   counts in the `<pre>` match what the Deno build prints for the same input.

Comparing against the *Deno build's* output rather than a fixture is the point: it is the
same wac, the same wasm and the same bridge, so any difference is the page's fault.

## Done, and the two warnings in this issue were both wrong (agent-a, 2026-08-03)

`cdn.playwright.dev` answers now — a bare request gets a 400 from the CDN rather than a 403
from the proxy — so somebody added it. Both cautions above turned out not to apply:

- **The `1234` revision was not a placeholder.** That is genuinely what the directory is
  called: `~/.cache/ms-playwright/chromium-1234`. I inferred a bug from a suspicious-looking
  number, which was a guess dressed as a finding.
- **arm64 Chromium downloaded without complaint**, and runs: 151.0.7922.34. What was actually
  missing was the system libraries, which `sudo playwright install-deps chromium` installs
  from Ubuntu's own archive — apt was never the obstacle for *those*, only for a browser.

`test/browser_live.test.ts` is the twenty-line test this issue asked for, give or take:
build the page, serve it with the two headers, drive it with Playwright, compare the page's
output to the Deno build's for the same input, and run `roundtrip.wac` for the filesystem.

**Ignored unless a browser is installed.** The repo has no third-party dependencies and this
does not change that: the guard is the presence of `~/.cache/ms-playwright`, the
`npm:playwright` import is dynamic and inside the test, and skipping costs 3ms and no
network. Deno drives Playwright directly, so there is no `node_modules` in the repo. The
three commands to install are in the file's header.

### It found a bug on the first run, which is the whole argument for doing this

`readDir(".")` answered **"not a directory"** in Chromium. OPFS has no `.` entry, so the path
resolver filtered it out, ended with an empty component list, threw "empty path", and the
application saw null. Deno and Node both answer `.` with the listing, so portable code asks
the obvious question and silently gets nothing.

The reason `browser.test.ts` missed it is worth keeping: **the double had the same assumption
as the code**. Both were written by the same person in the same hour, so the fake filesystem
agreed with the bug. That is the general limit of a hand-written double, and it is exactly
what this issue said "is an argument and not a proof" about — though I had expected the gap to
be in `SharedArrayBuffer` or `Atomics.wait`, and those worked first time. The untested-but-
shared part was fine; the browser-specific part was not.

Fixed with a `dirOf` helper that resolves `.`, `""`, `./` and `/` to the root, used by
`readDir` and `stat`. `browser.test.ts` has the case now, and it fails against the old code.

### Still true of a page, and not going to change

No TCP, so `connect`/`listen`/`accept` are refused rather than approximated. `rename` is a
copy and a delete, so it is not atomic — the one capability that is *weaker* in a browser
rather than absent, and the one a test cannot catch, since a non-atomic rename looks exactly
like an atomic one until two of them race.
