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

# Space, before blaming the change. This gate has failed twice on `No space left on device` for reasons
# outside this container: the shared overlay sits above 90% and only a few gigabytes of it are visible
# from in here. The operator's standing answer (2026-08-05) is to clear *Deno's* cache and retry.
#
# **It used to clear `gen`, which was the wrong directory.** Measured with the disk at 97%: `gen` held
# 220 MB and `v8_code_cache_v2` held 28 GB, so the mitigation freed under one per cent of the problem —
# three times — while reporting that it had done something. Both functions live in `cacheGuard.sh` now,
# shared with `tools/test.sh`, because a mitigation that only runs when somebody pushes is a mitigation
# nobody gets.
# shellcheck source=tools/cacheGuard.sh
. tools/cacheGuard.sh

for attempt in 1 2 3; do
  guardDenoCache

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
    # Elapsed on every branch, because "how long did it take" is the first thing anyone asks and
    # the answer distinguishes the two failure modes that look alike.
    if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
      echo "== the suite did not finish in 45m: not pushing =="
      echo "   This is a hang, not slowness — see issue 0036. Deno never kills a blocked test, so"
      echo "   the run would have continued indefinitely. Still running when it was cut:"
      grep -oE "'[^']+' has been running for over[^)]*.\)" "$log" | sort -u | head -10
    else
      # A failure that is really the shared disk: clear Deno's cache once and give the suite another go,
      # rather than reporting a change as broken when nothing about it was.
      if grep -q "No space left on device" "$log" && [ "$attempt" -lt 3 ]; then
        freeDenoCache
        continue
      fi

      echo "== tests failed after $((SECONDS - started))s: not pushing =="
      echo "-- failures --"
      grep -E 'FAILED|error:' "$log" | head -20
      # Any test that outstayed Deno's warning threshold is worth naming even on a plain failure:
      # it is the likeliest cause of a slow run somebody is about to blame on their own change.
      slow=$(grep -oE "'[^']+' has been running for over[^)]*.\)" "$log" | sort -u | head -5)
      [ -n "$slow" ] && { echo "-- tests that ran unusually long --"; echo "$slow"; }
    fi
    echo "-- full output: $log --"
    exit 1
  fi

  elapsed=$((SECONDS - started))
  echo "== suite passed in ${elapsed}s (load now $(cut -d' ' -f1-3 /proc/loadavg)) =="
  if [ "$elapsed" -gt 180 ]; then
    echo "   that is several times the usual ~50s. Usually the machine was busy rather than the"
    echo "   suite — but check for a hung test too (issue 0036); the load above tells you which."
    slow=$(grep -oE "'[^']+' has been running for over[^)]*.\)" "$log" | sort -u | head -5)
    [ -n "$slow" ] && { echo "-- tests that ran unusually long --"; echo "$slow"; }
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
