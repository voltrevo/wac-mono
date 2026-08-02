// Registers the wac-side key schedule tests and supplies HMAC-SHA256.
//
// `node:crypto` because it is synchronous — `crypto.subtle.sign` returns a Promise and a
// wasm call cannot await one. HMAC is the right granularity for the oracle: the schedule
// is HKDF built on a hash, and rebuilding HKDF from a hash we also wrote would let an
// error in the hash cancel out on both sides. Borrowing only the primitive means the
// expansion around it is checked by something that cannot share its mistakes.
import { createHmac } from "node:crypto";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const hmac = (key: Uint8Array, data: Uint8Array): Uint8Array =>
  new Uint8Array(createHmac("sha256", key).update(data).digest());

await wacTestRun("packages/tls/test/wac/keyschedule_test.wac", "keyschedule", [hmac]);
