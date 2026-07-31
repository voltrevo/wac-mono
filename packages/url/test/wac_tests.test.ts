// Registers the wac-written tests for this package.
import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/url/test/wac/url_test.wac", "url");
