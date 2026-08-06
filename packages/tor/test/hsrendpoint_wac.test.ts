// Registers the wac-side rendezvous-point resolution tests.
//
// No captured vector: the input is bytes an attacker chooses, so there is no "real" example to
// capture — the cases that matter are the ones nobody sends by accident. The rules come from tor\'s
// `hs_get_extend_info_from_lspecs` and `extend_info_addr_is_allowed`, cited in the wac file.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/tor/test/wac/hsrendpoint_test.wac", "hsrendpoint", [
  () => new Uint8Array(),
]);
