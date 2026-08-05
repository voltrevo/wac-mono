// Registers the wac-side X.509 generation tests, with OpenSSL as the oracle.
//
// Our own parser reading our own certificates would establish only that the two agree, and a DER
// encoder and decoder written together agree about their shared mistakes. So each certificate is
// handed to `openssl x509` and `openssl verify`, which have never seen this code, and the wac side
// separately checks that `x509.wac` reads it — since that is what a peer's TLS stack does.

import { generateKeyPairSync } from "node:crypto";
import { Buffer } from "node:buffer";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const V_RSA_KEY = 0, V_CHECK_CERT = 1, V_CERT_SUBJECT = 2, V_CERT_KEYTYPE = 3;

const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
const jwk = rsa.privateKey.export({ format: "jwk" }) as Record<string, string>;
const b64 = (s: string) =>
  new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
const N = b64(jwk.n), E = b64(jwk.e), D = b64(jwk.d);

const pem = (der: Uint8Array) => {
  const b64s = Buffer.from(der).toString("base64");
  const lines = b64s.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
};

/** Run openssl over a temporary PEM of the certificate. */
function opensslSync(args: string[], der: Uint8Array): { code: number; out: string; err: string } {
  const file = Deno.makeTempFileSync({ prefix: "wac-x509gen-", suffix: ".pem" });
  try {
    Deno.writeTextFileSync(file, pem(der));
    const r = new Deno.Command("openssl", {
      args: args.map((a) => (a === "@FILE" ? file : a)),
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    return {
      code: r.code,
      out: new TextDecoder().decode(r.stdout),
      err: new TextDecoder().decode(r.stderr),
    };
  } finally {
    try {
      Deno.removeSync(file);
    } catch { /* already gone */ }
  }
}

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  switch (what) {
    case V_RSA_KEY: {
      const be16 = (n: number) => [n >> 8, n & 0xff];
      return new Uint8Array([
        ...be16(N.length), ...N, ...be16(E.length), ...E, ...be16(D.length), ...D,
      ]);
    }
    case V_CHECK_CERT: {
      // Parsing and verifying are separate failures and both matter. `openssl verify` on a
      // self-signed certificate against itself checks the signature — which is the assertion that
      // `tbsCertificate` was encoded once and signed as encoded.
      const parsed = opensslSync(["x509", "-in", "@FILE", "-noout", "-text"], a);
      if (parsed.code !== 0) {
        throw new Error(`openssl could not parse the certificate:\n${parsed.err}`);
      }
      const verified = opensslSync(
        ["verify", "-no-CApath", "-no-CAfile", "-trusted", "@FILE", "@FILE"],
        a,
      );
      return new Uint8Array([verified.code === 0 ? 1 : 0]);
    }
    case V_CERT_SUBJECT: {
      const r = opensslSync(["x509", "-in", "@FILE", "-noout", "-subject"], a);
      // `subject=CN=wac relay` or `subject= CN = wac relay`, depending on the build.
      const m = r.out.match(/CN\s*=\s*(.+?)\s*$/m);
      return enc.encode(m ? m[1] : "");
    }
    case V_CERT_KEYTYPE: {
      const r = opensslSync(["x509", "-in", "@FILE", "-noout", "-text"], a);
      if (/ED25519/i.test(r.out)) return enc.encode("ED25519");
      if (/rsaEncryption/.test(r.out)) return enc.encode("rsaEncryption");
      return enc.encode("");
    }
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tls/test/wac/x509gen_test.wac", "x509gen", [ref]);
