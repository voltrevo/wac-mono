// Registers the wac-side circuit pool tests. No oracle and none wanted: the policy is pure,
// so every input is explicit and the assertions are exact.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/tor/test/wac/pool_test.wac", "pool");
