// Registers the wac-side responder handshake tests. No oracle: the layouts are fixed by tor-spec
// §4 and checked against the byte offsets it states, exactly as `cell_wac.test.ts` does. The
// interop check — a C tor client completing a handshake against our relay — is design/0002 step 3's
// done condition and needs the relay to exist.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/tor/test/wac/relaylink_test.wac", "relaylink");
