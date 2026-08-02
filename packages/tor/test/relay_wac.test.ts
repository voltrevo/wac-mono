// Registers the wac-side relay cell tests. The oracle is the other end of the circuit:
// a hop's key material read with the directions swapped is the relay facing us, so the
// two halves check each other rather than an implementation checking itself.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/tor/test/wac/relay_test.wac", "relay");
