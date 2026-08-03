// Registers the wac-side directory client tests. The randomness for the refresh schedule is
// a parameter, so the window can be swept exactly rather than sampled.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/tor/test/wac/dirclient_test.wac", "dirclient");
