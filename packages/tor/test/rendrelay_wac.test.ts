// Registers the wac-side rendezvous-point tests for the **relay**.
//
// No captured vector, deliberately and with a reason. The other relay-side files are pinned against
// cells C tor built; these two cells carry nothing a relay can verify — ESTABLISH_RENDEZVOUS is a
// twenty-byte cookie and RENDEZVOUS1 is that cookie followed by a handshake addressed to somebody
// else — so a captured cell would pin nothing a hand-written one does not. What is checked is the set
// of rules in `rendmid.c`, which are refusals and lifetimes rather than byte layouts.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/tor/test/wac/rendrelay_test.wac", "rendrelay", [
  () => new Uint8Array(),
]);
