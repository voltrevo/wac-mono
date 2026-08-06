// Registers the wac-side introduction-point lifetime tests.
//
// No captured vector: rotation is a decision a service makes privately, and nothing observable on a
// wire distinguishes a service that rotates correctly from one that does not — which is why the
// constants and the two decision functions come from tor's source, cited in the wac file.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/tor/test/wac/hsintropoint_test.wac", "hsintropoint", [
  () => new Uint8Array(),
]);
