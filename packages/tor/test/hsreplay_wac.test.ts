// Registers the wac-side INTRODUCE2 replay tests.
//
// No captured vector. The rules come from tor's `replaycache_add_and_test_internal` — SHA-256 of the
// data as the key, a horizon of zero meaning never expire, an entry inside the horizon counting as a
// hit, and a hit refreshing that entry — read in the source rather than observed on a wire, because
// what a service *drops* leaves nothing on a wire to observe.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/tor/test/wac/hsreplay_test.wac", "hsreplay", [
  () => new Uint8Array(),
]);
