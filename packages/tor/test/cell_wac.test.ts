// Registers the wac-side cell framing tests. No oracle: the layouts are fixed by
// tor-spec and checked against the byte offsets it states. The interop check that these
// are the bytes a real relay accepts is the link handshake test.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/tor/test/wac/cell_test.wac", "cell");
