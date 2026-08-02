// Registers the wac-side HMAC and HKDF tests, supplying HMAC-SHA256.
//
// The oracle is the primitive alone. Checking HKDF against a host HKDF would compare two
// implementations of the same construction; checking it against HMAC checks the
// construction — the counter, the chained T(n-1), the info placement — against something
// that has no opinion about any of it.
import { createHmac } from "node:crypto";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const hmac = (key: Uint8Array, data: Uint8Array): Uint8Array =>
  new Uint8Array(createHmac("sha256", key).update(data).digest());

await wacTestRun("packages/crypto/test/wac/kdf_test.wac", "kdf", [hmac]);
