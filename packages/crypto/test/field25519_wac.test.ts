// Registers the wac-side field tests. No oracle: the field's own laws, anchored by three
// values that name the modulus — which is what stops the laws holding in any ring at all.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/crypto/test/wac/field25519_test.wac", "field25519");
