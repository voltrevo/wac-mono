// Registers the wac-side hybrid tests. No oracle: every property is a relation between
// X25519MLKEM768's own outputs, not a value someone else has to supply.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/tls/test/wac/hybrid_test.wac", "hybrid");
