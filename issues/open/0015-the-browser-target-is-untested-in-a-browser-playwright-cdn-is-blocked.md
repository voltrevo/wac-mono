# 0015 — the browser target is untested in a browser; Playwright's CDN is blocked

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
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
