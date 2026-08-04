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

log="$(mktemp -t push-suite-XXXXXX.log)"

for attempt in 1 2 3; do
  # Inside the loop, not before it. A merge on a later attempt can bring in a commit that
  # bumps the compiler pin, and then the next run fails on a stale compiler for a reason
  # that has nothing to do with the change being pushed. Pulling once at the top misses
  # exactly that case, which is the one it was put there to catch.
  if [ -d ../wac ]; then
    git -C ../wac pull --quiet --no-rebase ||
      echo "note: could not pull wac; the version check will say if it matters"
  fi

  # What the machine was doing, before and after. This container is shared with other agents,
  # and a mutation sweep next door turns a fifty-second suite into half an hour — which looks
  # exactly like a hang if nothing says otherwise. Twice now that has cost time to diagnose, so
  # the numbers are printed rather than remembered.
  echo "== running the suite (attempt $attempt) =="
  echo "   load $(cut -d' ' -f1-3 /proc/loadavg) on $(nproc) cores"
  started=$SECONDS
  # Tee'd rather than swallowed. The first version printed only "tests failed", which is the
  # one moment the output is worth having — and when this runs unattended the terminal
  # scrollback is not there to fall back on.
  #
  # This is a pipeline guarding a consequential action, which is the mistake the whole file
  # exists to prevent. It is safe *only* because `pipefail` is set above, so the pipeline
  # takes the exit code of `deno task test` rather than of `tee`. Remove `pipefail` and this
  # line silently starts pushing red trees. Do not drop the `set -uo pipefail`.
  if ! deno task test 2>&1 | tee "$log"; then
    echo
    echo "== tests failed after $((SECONDS - started))s: not pushing =="
    echo "-- failures --"
    grep -E 'FAILED|error:' "$log" | head -20
    echo "-- full output: $log --"
    exit 1
  fi

  elapsed=$((SECONDS - started))
  echo "== suite passed in ${elapsed}s (load now $(cut -d' ' -f1-3 /proc/loadavg)) =="
  if [ "$elapsed" -gt 180 ]; then
    echo "   that is several times the usual ~50s: the machine was busy, not the suite"
  fi

  if git push --quiet origin master 2>/dev/null; then
    echo "== pushed =="
    rm -f "$log"
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
