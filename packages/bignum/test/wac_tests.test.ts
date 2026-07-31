// Registers the wac-written tests for this package.
import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/bignum/test/wac/big_test.wac", "bignum-wac");
