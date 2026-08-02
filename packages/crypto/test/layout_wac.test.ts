// Registers the wac-side byte-order tests. No oracle: round trips plus a few literal
// values where the two orders visibly differ, which is what a DataView comparison was
// buying at the cost of a host call per offset.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/crypto/test/wac/layout_test.wac", "layout");
