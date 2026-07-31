// Registers the wac-written tests for the shared byte buffer.
import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/bytes/test/wac/buf_test.wac", "buf");
