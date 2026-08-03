// Registers the wac-side circuit tests. No host oracle: the relay half is built from the
// same key material with the directions swapped, and whole cells cross between them.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/tor/test/wac/circuit_test.wac", "circuit");
