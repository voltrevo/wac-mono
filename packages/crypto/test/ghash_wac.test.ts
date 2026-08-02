// Registers the wac-side GHASH tests. No oracle: the field's algebra is the check.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/crypto/test/wac/ghash_test.wac", "ghash");
