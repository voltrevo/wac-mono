#!/usr/bin/env bash
# Run the suite, then push only if it passed. Merge and retry if someone got there first.
#
# This exists because `deno task test 2>&1 | grep ... && git push` pushes on *grep's* exit
# code, not the test run's. It looks like it guards the push and does not. I made that
# mistake twice in one session, and both times the tree happened to be fine — the failures
# were my own stale compiler — which is exactly the kind of luck that teaches nothing.
#
# Usage: tools/push.sh
set -uo pipefail

cd "$(dirname "$0")/.."

# Refuse to run with a dirty tree. The tests would pass against the working copy and the
# push would carry the last commit, so it reports success for work that never left the
# machine — which is worse than failing, because there is nothing to notice. I did this
# within an hour of writing the script.
if [ -n "$(git status --porcelain)" ]; then
  echo "== uncommitted changes: commit them first, or the push will not include them =="
  git status --short
  exit 1
fi

# A stale compiler makes every other package look broken, so rule it out before believing a
# red suite. The version check in the harness reports it precisely; this just gets ahead of it.
if [ -d ../wac ]; then
  git -C ../wac pull --quiet --no-rebase || echo "note: could not pull wac; version check will say if it matters"
fi

for attempt in 1 2 3; do
  echo "== running the suite (attempt $attempt) =="
  if ! deno task test; then
    echo "== tests failed: not pushing =="
    exit 1
  fi

  if git push --quiet origin master 2>/dev/null; then
    echo "== pushed =="
    exit 0
  fi

  echo "== push rejected, merging and retrying =="
  if ! git pull --no-rebase --no-edit --quiet origin master; then
    echo "== merge needs hands: resolve, then run this again =="
    exit 1
  fi
done

echo "== still being beaten to the push after three tries; try again in a moment =="
exit 1
