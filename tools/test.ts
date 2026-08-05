#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run
// `deno task test`, with the worker count capped.
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
// **The cap is 2 and that number is not measured.** Comparing 2 against 5 needs a quiet machine
// and this one has not been quiet — three agents, load 11-13 on five cores — so any figure taken
// now would describe the contention rather than the choice. Issue 0075 is to measure it properly
// and set it from evidence. Until then 2 is a deliberate guess on the safe side, and the override
// is there because a guess should be easy to disagree with.
//
// `${DENO_JOBS:-2}` in the task itself would have been simpler and does not work: deno's task
// shell does not expand parameter defaults, and passes the text through literally.

const DEFAULT_JOBS = 2;

const env = Deno.env.get("DENO_JOBS");
const override = env !== undefined && Number(env) > 0 ? Math.floor(Number(env)) : null;
const jobs = override ?? DEFAULT_JOBS;

console.log(
  override === null
    ? `${jobs} workers (the default cap — see issue 0075; DENO_JOBS=n overrides)`
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
  env: { DENO_JOBS: String(jobs) },
  stdout: "inherit",
  stderr: "inherit",
}).output();

Deno.exit(r.code);
