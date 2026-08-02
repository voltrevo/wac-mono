// Registers the wac-side SHA-1 tests and supplies node's, synchronously.
import { createHash } from "node:crypto";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const sha1 = (b: Uint8Array) => new Uint8Array(createHash("sha1").update(b).digest());

await wacTestRun("packages/crypto/test/wac/sha1_test.wac", "sha1", [sha1]);
