// Registers the wac-side constant-time comparison tests.
//
// No vector: the properties are about the comparison itself, not about any protocol. The one that
// matters — that every byte is compared — is checked here because it cannot be checked anywhere else.
// A MAC or a replay-digest test feeds real inputs, and no two real digests agree on a prefix, so a
// truncated comparison passes every one of them. This file chooses the bytes instead.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/crypto/test/wac/ct_test.wac", "ct", [() => new Uint8Array()]);
