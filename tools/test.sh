#!/usr/bin/env bash
# `deno task test`, with the cache guard in front of it.
#
# A wrapper rather than a plain `deno test` line in `deno.json` because the guard has to run somewhere
# everybody passes through, and this is that place: `tools/push.sh` gates pushes, but the suite is run by
# hand dozens of times a day. Arguments pass straight through, so `deno task test packages/sh/` still
# works.
set -uo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=tools/cacheGuard.sh
. tools/cacheGuard.sh
guardDenoCache
exec deno test --parallel --allow-read --allow-write --allow-run --allow-net --allow-env "$@"
