// Structural properties of the crypto primitives, written in wac.
// See test/wac/crypto_test.wac; the vector-based tests are the sibling .test.ts files.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/crypto/test/wac/crypto_test.wac", "crypto");
