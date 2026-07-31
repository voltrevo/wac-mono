// Registers the wac-written tests for this package.
import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/fmt/test/wac/ftoa_test.wac", "ftoa-wac");
