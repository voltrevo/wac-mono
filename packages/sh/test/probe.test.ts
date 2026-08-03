// The coverage probe still compiles.
//
// `cov.ts` is not part of `deno task test` — it is slow and it is a measurement, not a check — so
// nothing in the suite touches `test/wac/probe.wac`. That was fine until the probe started
// building a whole fake capability world, and now every change to `Cli` or `Core` in
// `packages/platform` breaks it silently. It has broken twice: once when capabilities began
// returning `Pending<T>`, and once when `waitAny` moved from `Cli` to `Core` and `spawn` gained an
// argument. Both times the suite stayed green and `deno task coverage:sh` was simply dead until
// someone happened to run it.
//
// One `wacBind` is enough to catch that, and it costs about a second. It deliberately asserts
// nothing about coverage: this is a compile check wearing a test's clothes, and saying so here is
// cheaper than the next person wondering why it asserts so little.

import { wacBind } from "../../../harness/wacBind.ts";

Deno.test("the coverage probe compiles against the current platform", async () => {
  const mod = await wacBind("packages/sh/test/wac/probe.wac") as unknown as {
    shStatus(src: string): number;
  };
  // And it runs, so a probe that compiles but cannot build its fake world is caught too.
  const status = mod.shStatus("exit 3");
  if (status !== 3) throw new Error(`the probe ran 'exit 3' and reported ${status}`);
});
