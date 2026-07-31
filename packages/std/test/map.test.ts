// Registers the wac-written tests for the hash map, including the differential run against
// a naive association list.
import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/std/test/wac/map_test.wac", "map");
