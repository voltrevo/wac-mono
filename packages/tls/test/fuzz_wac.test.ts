// Registers the wac-side TLS fuzzing.
//
// The generator is deterministic so a finding is reproducible, but the client needs real
// entropy for its own keys — a handshake seeded from a counter would be a different program.
// That comes from here; everything the fuzzer chooses comes from the PRNG.
import { wacTestRun } from "../../../harness/wacTestRun.ts";
import { pemToDer } from "../host/connect.ts";

const material = [32, 32, 64, 32].map((n) => crypto.getRandomValues(new Uint8Array(n)));
// A real certificate and its issuer, as the corpus to mutate. Fixtures rather than generated
// DER: the interesting inputs are the ones that are *nearly* a certificate.
const certs = await Promise.all(
  ["ec_leaf", "ec_ca"].map(async (n) =>
    pemToDer(await Deno.readTextFile(new URL(`./data/${n}.pem`, import.meta.url)))),
);
await wacTestRun("packages/tls/test/wac/fuzz_test.wac", "tlsfuzz",
  [(n: number) => material[n], (n: number) => certs[n]]);
