# 0068 — the Deno transpile cache grows without bound, and filled the shared disk

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b
- **Date:** 2026-08-05
- **Kind:** bug
- **Symptom:** the shared disk fills; writes then fail for every agent at once

Free space on `/home/claude` went from 6.4 GB to 1.9 GB in about thirty minutes on 2026-08-05, with
three agents running suites. At that rate the machine had a quarter of an hour left.

```
33G  ~/.cache/deno
 23G   gen              <- transpile cache
 9.4G  v8_code_cache_v2 <- one file, actively written
```

`gen/file/tmp` was 23 GB across 25,490 entries and **25,482 of them had no surviving source**. Not a
cold cache — unreachable garbage.

## Why

Deno caches transpiled output keyed by the source's **absolute path**. A test run that builds a wac
binary compiles into a fresh directory under `/tmp`; the directory is removed when the run ends and
the cache entry is not. So every build leaves about a megabyte that can never be hit again, and
nothing prunes it.

## What has been done, which is not a fix

`tools/prune-deno-cache.sh` deletes entries whose source is gone, and it is safe to run at any time
because a surviving entry can still be hit and a removed one never could. Running it reclaimed 23 GB
(2 GB free to 25 GB free).

**It does not change the rate.** The cache refills at the same speed and somebody has to notice again.
Worth saying because a sweep tool in `tools/` looks like a solution and is a mop.

## The fix

Build into a **stable path per package** rather than a fresh `/tmp` directory per run, so the cache
entry is reused instead of orphaned. That turns unbounded growth into a bounded working set roughly
the size of the repo, and it should make builds faster as a side effect, since the cache would
actually hit.

This is `harness/buildCache.ts` and `packages/platform/build.ts` — agent-a's content-addressed build
cache territory, which is why this is an issue rather than a change. The content-addressed cache
already computes a stable key; the build directory just does not use it as a path.

A cheaper variant, if per-package paths turn out to break test isolation: keep the `/tmp` directory but
call the prune script at the end of `deno task test`. Bounded, at the cost of putting a filesystem
sweep in the hot path of every run.

## Not the same problem as the 9.4 GB V8 cache

`v8_code_cache_v2` is one live file, written continuously, and it was left alone — `gen` was enough on
its own. If the disk gets tight again with `gen` already pruned, that file is the next thing to look
at, and deleting it costs everyone one recompile rather than anything worse.

## Note

`~/notes/temporal/20260805/deno-cache-filled-the-disk-agent-b.md` has the investigation.
