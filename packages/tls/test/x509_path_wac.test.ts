// Loads the certificate fixtures and hands them to the wac path tests.
//
// A fourth shape for the boundary, and worth distinguishing from the others: this callback
// is not an oracle but a **loader**. Nothing here supplies an answer — the fixtures are
// inputs, and wac cannot read a file. That changes what the host is trusted for. A wrong
// oracle makes a test wrong; a wrong input makes it fail, loudly, on the first parse.
import { pemToDer } from "../host/connect.ts";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const FIXTURES = [
  "p384_root", "p384_inter", "p384_leaf", "other_ca", "p384_imposter",
  "p384_leaf_crit", "p384_leaf_noncrit", "p384_leaf_clientauth", "p384_leaf_serverauth",
  "p384_nc_ok", "p384_nc_bad", "p384_nc_excl", "p384_nc_ip", "p384_nc_suffix",
  "p384_nc_upper",
  // For the IP-address matching rule: `ec_leaf` carries both DNS and iPAddress SANs,
  // `ip_as_dns` names an address as a dNSName only and must never match it.
  "ec_leaf", "ip_as_dns",
];

const der: Uint8Array[] = [];
for (const name of FIXTURES) {
  der.push(pemToDer(await Deno.readTextFile(new URL(`./data/${name}.pem`, import.meta.url))));
}

await wacTestRun("packages/tls/test/wac/x509_path_test.wac", "x509", [(n: number) => der[n]]);
