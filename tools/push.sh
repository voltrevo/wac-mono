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

  echo "== running the suite (attempt $attempt) =="
  # Tee'd rather than swallowed. The first version printed only "tests failed", which is the
  # one moment the output is worth having — and when this runs unattended the terminal
  # scrollback is not there to fall back on.
  #
  # This is a pipeline guarding a consequential action, which is the mistake the whole file
  # exists to prevent. It is safe *only* because `pipefail` is set above, so the pipeline
  # takes the exit code of `deno task test` rather than of `tee`. Remove `pipefail` and this
  # line silently starts pushing red trees. Do not drop the `set -uo pipefail`.
  # `timeout` is a backstop against a *hang*, not a performance gate.
  #
  # Deno 2.9 has no per-test timeout — none at all, and none configurable. When a test blocks
  # forever it prints "has been running for over (4m0s)" and keeps printing it, and the run never
  # ends. Several tests here wait on a subprocess announcing readiness with no deadline of their
  # own (`waitForListening` in box's tests, three separate `serveOnce` helpers), and the ports come
  # from bind-then-release, which races under `--parallel`. So an unbounded wait is reachable, and
  # this script is the push gate: unbounded here means an agent sits for an hour with nothing to
  # read but a warning.
  #
  # The value is deliberately far above any legitimate run — the suite is about fifty seconds
  # alone, and the worst honest figure anybody has recorded on a loaded machine is half an hour.
  # Anything past this is not slow, it is stuck. Picking a tighter bound would recreate the
  # false-failure problem that kept issue 0031 open: a guard that fires on a busy machine gets
  # switched off.
  timeout --kill-after=30s 45m deno task test 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  if [ "$status" -ne 0 ]; then
    echo
    if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
      echo "== the suite did not finish in 45m: not pushing =="
      echo "   This is a hang, not slowness. Deno never kills a blocked test, so the run would"
      echo "   have continued indefinitely. The tests below were still running when it was cut:"
      grep -oE "'[^']+' has been running for over[^)]*.\)" "$log" | sort -u | head -10
    else
      echo "== tests failed: not pushing =="
      echo "-- failures --"
      grep -E 'FAILED|error:' "$log" | head -20
    fi
    # Any test that outstayed Deno's warning threshold is worth naming even on a plain failure:
    # it is the most likely cause of a slow run somebody else is about to blame on their own work.
    if [ "$status" -ne 124 ] && [ "$status" -ne 137 ]; then
      slow=$(grep -oE "'[^']+' has been running for over[^)]*.\)" "$log" | sort -u | head -5)
      [ -n "$slow" ] && { echo "-- tests that ran unusually long --"; echo "$slow"; }
    fi
    echo "-- full output: $log --"
    exit 1
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
