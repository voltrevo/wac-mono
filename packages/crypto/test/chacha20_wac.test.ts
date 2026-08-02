// Registers the wac-side ChaCha20 tests. No oracle: WebCrypto has no ChaCha20 and
// node:crypto exposes it only inside the AEAD, so RFC 8439's vectors are the whole
// external check — which is why the structural properties beside them carry more weight
// here than they usually would.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/crypto/test/wac/chacha20_test.wac", "chacha20");
