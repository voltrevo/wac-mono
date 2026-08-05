// The filesystem's own tests, written in wac.
import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/fs/test/wac/fs_test.wac", "fs");
