// Registers the wac-side path selection tests.
//
// No oracle and none wanted: the chooser takes its randomness as an argument, so the tests
// sweep the whole random space and assert the distribution exactly rather than sampling it.
// A statistical test loose enough never to flake would be loose enough to miss a real bias.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/tor/test/wac/pathsel_test.wac", "pathsel");
