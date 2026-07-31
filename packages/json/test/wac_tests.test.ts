// Registers the wac-written tests for this package.
//
// These cover internals and the parsed tree, which the host-side tests cannot
// reach — a JsonValue is a GC reference and only primitives cross the bindgen
// boundary. Conformance still lives in the host tests, where the oracle is.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/json/test/wac/json_test.wac", "json");
