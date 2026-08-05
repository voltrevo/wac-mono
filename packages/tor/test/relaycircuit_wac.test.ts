// Registers the wac-side relay circuit tests. Client and relay are both ours here, so this is not a
// differential — the ntor arithmetic underneath is already checked against tor's `test-ntor-cl` in
// `ntor_wac.test.ts`, from both directions. What this adds is the cell layer and the direction of
// the key material, and the real check is a C tor client building a circuit through our relay.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/tor/test/wac/relaycircuit_test.wac", "relaycircuit");
