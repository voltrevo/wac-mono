// The real trust store parses.
//
// Only this one. Path building, the extension rules and the name constraints all moved to
// `test/wac/x509_path_test.wac`, where the host is a fixture loader rather than an oracle.
//
// This stayed because it reads /etc/ssl and reports on what it finds — 121 certificates
// using algorithms this does not implement, several of which would trap on a strict parse.
// Unsupported has to stay distinct from malformed, or one exotic root makes the other 120
// unusable, which is exactly what happened before parseCert learned to leave keyType at 0
// rather than trap.

import { wacBind } from "../../../harness/wacBind.ts";
import { pemBundle } from "../host/connect.ts";

const mod = await wacBind("packages/tls/test/wac/probe.wac");
const x509Parse = mod.x509Parse as (der: Uint8Array) => Uint8Array;

const KEY_P384 = 4, KEY_RSA = 3;
const parsed = (der: Uint8Array) => ({ keyType: x509Parse(der)[17] });

Deno.test("x509: the system trust store parses without a single certificate taking it down", async () => {
  // 121 roots using algorithms this does not implement, several of which would trap on a
  // strict parse. Unsupported has to be distinct from malformed, or one exotic root in the
  // bundle makes the other 120 unusable — which is exactly what happened before parseCert
  // learned to leave keyType at 0 rather than trap.
  let pem: string;
  try {
    pem = await Deno.readTextFile("/etc/ssl/certs/ca-certificates.crt");
  } catch {
    return; // no system store here; nothing to check
  }
  const store = pemBundle(pem);
  const n = store.offsets.length / 2;
  if (n < 50) throw new Error(`expected a real trust store, found ${n} certificates`);
  const seen = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const der = store.der.subarray(store.offsets[2 * i], store.offsets[2 * i + 1]);
    const t = parsed(der).keyType;   // must not throw for any of them
    seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  // The store is overwhelmingly RSA with a minority of elliptic-curve roots, and the P-384
  // ones are the reason this test file exists.
  if ((seen.get(KEY_P384) ?? 0) === 0) throw new Error("expected at least one P-384 root");
  if ((seen.get(3) ?? 0) === 0) throw new Error("expected RSA roots");
});
