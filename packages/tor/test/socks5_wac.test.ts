// Registers the wac-side SOCKS5 and TLS-record-framing tests.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/tor/test/wac/socks5_test.wac", "socks5");
