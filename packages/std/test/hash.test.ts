// Registers the wac-written tests for the hash functions' distribution.
import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/std/test/wac/hash_test.wac", "hash");
