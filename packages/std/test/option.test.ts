// Registers the wac-written tests for Option and Result.
import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/std/test/wac/option_test.wac", "option");
