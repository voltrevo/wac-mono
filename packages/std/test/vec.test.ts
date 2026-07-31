// Registers the wac-written tests for the growable array.
import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/std/test/wac/vec_test.wac", "vec");
