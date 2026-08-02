// Registers the wac-side wire tests. No oracle: a Reader is bytes in, bytes out.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/tls/test/wac/wire_test.wac", "wire");
