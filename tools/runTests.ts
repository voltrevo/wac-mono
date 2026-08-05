#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
// `deno task test`, with the worker count capped and Deno's code cache kept in bounds.
//
// **Not named `test.ts`, and that is load-bearing.** It was, for about an hour, and the suite ran
// itself: `deno test` collects `*_test.ts`, `*.test.ts` *and* bare `test.{ts,js,mjs,mts}`, so every
// suite run imported this file as a test module and executed its top level, which launches a suite.
// One child per generation, about 100 seconds apart, unbounded. It reached seventeen levels and load
// 122 on a five-core machine shared with two other agents, and the host had to be rebooted.
// `tools/discovery.test.ts` now fails if any file in the repo can be collected that way without
// declaring a test. wac-mono 0077.
//
// `deno test --parallel` defaults to one worker per core. That is right for a suite of pure
// computation and wrong for this one, because a test here is frequently a *process*:
// `packages/box` and `packages/sh` spawn a built wac binary per case, and each is an 85 MB Deno
// isolate. Five workers each holding one, plus the five workers themselves, is over a gigabyte of
// transient allocation — on a machine three agents share.
//
// The symptom was `packages/ssz/test/merkle_wac.test.ts` failing with a bare "Uncaught error" and
// passing on its own: a worker killed for memory, reported as though the test were wrong.
//
//   deno task test                      # everything, capped
//   deno task test packages/json        # a subset, same cap
//   DENO_JOBS=5 deno task test          # override, honoured as given
//
// **The cap is 4, and it is measured.** `tools/jobsSweep.sh` on a quiet machine (load 1.9, 8.8 GB
// available, 5 cores), sampling `/sys/fs/cgroup/memory.current` through each run — issue 0075:
//
//   jobs   wall      peak      rise   result
//   1      173s    4894MB    2468MB   1134 passed
//   2       95s    5725MB    3261MB   1134 passed
//   3       73s    6599MB    2882MB   1134 passed
//   4       59s    5735MB    3290MB   1134 passed
//   5        -         -         -    FAILED: AddrInUse
//
// Two things in that table are worth more than the number. **Memory barely moves**: the rise is
// 2.5–3.3 GB whether one worker runs or four, because the peak is dominated by the built binaries a
// single test file spawns — 85 MB of Deno isolate each, sixty of them in `packages/box` — and not by the
// workers. The 300 MB-per-worker figure this comment used to assume was wrong, so the memory argument
// for a low cap was weaker than it looked.
//
// And **five does not fail for memory**: it fails with `AddrInUse: Address already in use`, which is
// wac-mono 0069 — tests take a port by binding it and releasing it, then bind it again, and a fifth
// worker wins that race often enough to redden a run. The ceiling here is a bug rather than the machine,
// so if 0069 is fixed this should be measured again rather than assumed to stay at 4.
//
// Four is also *kinder* to the other agents than two, which is the opposite of what a cap suggests: the
// run finishes in 59s instead of 95s, so the window during which this process holds three gigabytes is
// forty per cent shorter. What no per-process cap can do is bound the *machine* — three agents at 3 GB
// each is 9 GB of 11.9 — and that is 0031, which wants a token every heavy runner takes.
// `${DENO_JOBS:-2}` in the task itself would have been simpler and does not work: deno's task
// shell does not expand parameter defaults, and passes the text through literally.

import { refuseIfNested, SUITE_ENV } from "./suiteGuard.ts";

const DEFAULT_JOBS = 4;

/**
 * Deno's code cache, cleared when it is over the limit.
 *
 * Here rather than in a shell function so that there is one implementation: `tools/push.sh` calls this
 * file too. The cache keys on content and never evicts, and this repo runs a lot of unique scripts, so
 * it reached 28 GB on a 155 GB disk shared by three agents — wac-mono 0068.
 */
const CACHE_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;

function guardCodeCache(): void {
  const dir = Deno.env.get("DENO_DIR") ?? `${Deno.env.get("HOME")}/.cache/deno`;
  const db = `${dir}/v8_code_cache_v2`;
  let size = 0;
  try {
    size = Deno.statSync(db).size;
  } catch {
    return; // no cache yet, nothing to bound
  }
  if (size <= CACHE_LIMIT_BYTES) return;
  console.log(
    `clearing Deno's code cache: ${Math.round(size / 1024 / 1024)} MB, over the ` +
      `${Math.round(CACHE_LIMIT_BYTES / 1024 / 1024)} MB limit`,
  );
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      Deno.removeSync(db + suffix);
    } catch {
      // Another runner cleared it first, or it was never there.
    }
  }
}

/** Everything Deno caches, for when the disk is actually full. `push.sh free` calls this. */
function freeCaches(): void {
  const dir = Deno.env.get("DENO_DIR") ?? `${Deno.env.get("HOME")}/.cache/deno`;
  for (const path of [`${dir}/v8_code_cache_v2`, `${dir}/v8_code_cache_v2-wal`,
    `${dir}/v8_code_cache_v2-shm`]) {
    try { Deno.removeSync(path); } catch { /* already gone */ }
  }
  try { Deno.removeSync(`${dir}/gen`, { recursive: true }); } catch { /* already gone */ }
}

// `runTests.ts free` is the disk-full path, called by `tools/push.sh`. It clears and returns; it does
// not run the suite.
if (Deno.args[0] === "free") {
  freeCaches();
  Deno.exit(0);
}
if (Deno.args[0] === "guard") {
  guardCodeCache();
  Deno.exit(0);
}

// After the subcommands, which start no suite, and before anything expensive.
refuseIfNested("deno task test");
guardCodeCache();

const env = Deno.env.get("DENO_JOBS");
const override = env !== undefined && Number(env) > 0 ? Math.floor(Number(env)) : null;
const jobs = override ?? DEFAULT_JOBS;

console.log(
  override === null
    ? `${jobs} workers (measured — see issue 0075; DENO_JOBS=n overrides)`
    : `${jobs} workers (DENO_JOBS)`,
);

const r = await new Deno.Command(Deno.execPath(), {
  args: [
    "test",
    "--parallel",
    "--allow-read",
    "--allow-write",
    "--allow-run",
    "--allow-net",
    "--allow-env",
    ...Deno.args,
  ],
  env: { DENO_JOBS: String(jobs), ...SUITE_ENV },
  stdout: "inherit",
  stderr: "inherit",
}).output();

Deno.exit(r.code);
