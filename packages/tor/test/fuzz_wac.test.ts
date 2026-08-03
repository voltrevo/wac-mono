// Registers the wac-side fuzzing. Deterministic, so a failure is reproducible from its seed.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/tor/test/wac/fuzz_test.wac", "fuzz");
