#!/usr/bin/env bash
# Issue 0075: pick DENO_JOBS from evidence.
#
# The first version of this decided pass/fail by grepping deno's summary line, which has ANSI
# codes between the number and the word, so it never matched — and every run had in fact been
# killed while the table printed timings as though they were data. Status is the exit code here,
# and a run that did not pass prints no number at all.
#
# Those runs died because of 0077, not because of anything this measures: a `tools/test.ts` was
# being collected as a test module by the suite it launched, so each run re-entered the suite
# without bound. Hence the marker below.
cd "$(git rev-parse --show-toplevel)"
# The marker every tool that spawns a suite sets — see `tools/suiteGuard.ts`. This calls `deno test`
# directly rather than through `runTests.ts`, because setting DENO_JOBS per run is the whole point,
# so it has to set the marker itself: without it a test that invoked one of our tools would not be
# refused, which is the second half of 0077.
export WAC_SUITE_RUNNING=1
ARGS=(--parallel --allow-read --allow-write --allow-run --allow-net --allow-env)

run() {   # run <jobs> <logfile>; echoes "<exit> <wall_ms>"
  local t0 rc
  t0=$(date +%s%N)
  DENO_JOBS=$1 deno test "${ARGS[@]}" >"$2" 2>&1
  rc=$?
  echo "$rc $(( ($(date +%s%N) - t0) / 1000000 ))"
}

echo "load $(cut -d' ' -f1-3 /proc/loadavg)  swap $(free -m | awk '/Swap/{print $3}')MB  deno-cache $(du -sh ~/.cache/deno | cut -f1)"

# Warm sequentially: one worker is the least memory this can take, and a cold cache at higher
# parallelism is what the OOM killer ate last time. Verified by exit code before going on.
echo "warming (jobs=1, cold cache — this is the slow one)..."
read -r wrc wms <<<"$(run 1 /tmp/w.log)"
echo "  exit=$wrc  $((wms/1000))s  $(sed 's/\x1b\[[0-9;]*m//g' /tmp/w.log | grep -oE '[0-9]+ passed \| [0-9]+ failed' | tail -1)"
if [ "$wrc" -ne 0 ]; then
  echo "ABORT: the warm-up did not pass, so no timing below would mean anything."
  sed 's/\x1b\[[0-9;]*m//g' /tmp/w.log | tail -5
  exit 1
fi

echo
printf "%-5s %7s %9s %9s  %s\n" jobs wall peak rise result
for j in 1 2 3 4 5; do
  pf=$(mktemp)
  ( while :; do cat /sys/fs/cgroup/memory.current; sleep 0.2; done > "$pf" ) & s=$!
  read -r rc ms <<<"$(run "$j" /tmp/j$j.log)"
  kill $s 2>/dev/null; wait $s 2>/dev/null
  hi=$(sort -rn "$pf" | head -1); lo=$(sort -n "$pf" | head -1); rm -f "$pf"
  summary=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/j$j.log | grep -oE '[0-9]+ passed \| [0-9]+ failed' | tail -1)
  if [ "$rc" -eq 0 ]; then
    printf "%-5s %6ss %8sMB %8sMB  %s\n" "$j" "$((ms/1000))" "$((hi/1048576))" "$(( (hi-lo)/1048576 ))" "$summary"
  else
    printf "%-5s %7s %9s %9s  FAILED exit=%s after %ss — %s\n" "$j" - - - "$rc" "$((ms/1000))" "${summary:-no summary: it did not finish}"
  fi
done
echo
echo "load $(cut -d' ' -f1-3 /proc/loadavg)  swap $(free -m | awk '/Swap/{print $3}')MB"
