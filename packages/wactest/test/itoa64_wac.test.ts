// itoa64/utoa64 boundary cases, written in wac. See test/wac/itoa64_test.wac;
// the exhaustive comparison against BigInt is in itoa64.test.ts.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/wactest/test/wac/itoa64_test.wac", "itoa64");
