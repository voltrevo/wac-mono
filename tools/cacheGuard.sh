#!/usr/bin/env bash
# Keep Deno's code cache from filling the shared disk. Sourced by `tools/test.sh` and `tools/push.sh`.
#
# Deno keeps V8's compiled code for every script it runs, keyed by content, in
# `~/.cache/deno/v8_code_cache_v2`, and never evicts. This repo runs a *lot* of unique scripts: every
# built program is a fresh 400 KB bundle, and every wac test is a fresh bundle evaluated in process. So
# the cache grows without bound and none of it can ever be hit again.
#
# Measured on 2026-08-05, disk at 97% with 5.9 GB free: that one file held **28 GB**. One run of `box`'s
# test file added 166 MB. Built programs stopped contributing when their shebang gained
# `--no-code-cache` (wac-mono 0068), which took a full suite's growth from 1.4 GB to about 1.2 GB — the
# rest is `deno test` itself compiling in-process bundles, and `deno test` has no such flag.
#
# So: a limit, checked with one `stat` before a run. Nothing here needs a warm cache to be *large*.
CACHE_LIMIT_BYTES=${CACHE_LIMIT_BYTES:-$((4 * 1024 * 1024 * 1024))}

guardDenoCache() {
  local db="${DENO_DIR:-$HOME/.cache/deno}/v8_code_cache_v2"
  [ -f "$db" ] || return 0
  local size
  size="$(stat -c %s "$db" 2>/dev/null || echo 0)"
  if [ "$size" -gt "$CACHE_LIMIT_BYTES" ]; then
    echo "== Deno's code cache is $((size / 1024 / 1024)) MB, over the $((CACHE_LIMIT_BYTES / 1024 / 1024)) MB limit: clearing it =="
    rm -f "${db}"* 2>/dev/null || true
  fi
}

# Everything Deno caches, for when the disk is actually full. The repo's own `.cache` is left alone: it
# is small, and every test repopulates it with the same bytes anyway.
freeDenoCache() {
  echo "== the disk is full and it is not this change: clearing Deno's caches =="
  du -sh "${DENO_DIR:-$HOME/.cache/deno}"/* 2>/dev/null | sort -h | tail -3
  rm -f "${DENO_DIR:-$HOME/.cache/deno}"/v8_code_cache_v2* 2>/dev/null || true
  rm -rf "${DENO_DIR:-$HOME/.cache/deno}/gen" 2>/dev/null || true
  df -h / | tail -1
}
