import { wacBind } from "./harness/wacBind.ts";
const m = await wacBind("packages/tls/test/wac/probe.wac");
const parse = m.x509Parse as (d: Uint8Array) => Uint8Array;
const signedBy = m.x509SignedBy as (a: Uint8Array, b: Uint8Array) => boolean;
const chain = m.x509VerifyChain as (a: Uint8Array, b: Uint8Array, h: Uint8Array, n: bigint) => number;
const KEY = ["?", "ed25519", "p256", "rsa"], SIG = ["?", "ed25519", "ecdsa256", "ecdsa384", "rsa256", "rsa384", "rsa512", "rsapss"];
const now = BigInt(Math.floor(Date.now()/1000));
const enc = new TextEncoder();
for (const [name, leafF, caF] of [["ed25519","server.der","ca.pem"],["ecdsa","ec_leaf.der","ec_ca.der"],["rsa","rsa_leaf.der","rsa_ca.der"]] as const) {
  const leaf = await Deno.readFile(`packages/tls/test/data/${leafF}`);
  let ca: Uint8Array;
  if (caF.endsWith(".pem")) { const t = await Deno.readTextFile(`packages/tls/test/data/${caF}`); ca = Uint8Array.from(atob(t.replace(/-----[^-]+-----|\s/g,"")), c=>c.charCodeAt(0)); }
  else ca = await Deno.readFile(`packages/tls/test/data/${caF}`);
  const f = parse(leaf);
  const keyLen = (f[19]<<8)|f[20];
  console.log(`${name.padEnd(8)} key=${KEY[f[17]]} sig=${SIG[f[18]]} keyBytes=${keyLen} signedByCa=${signedBy(leaf, ca)} chain=${chain(leaf, ca, enc.encode("wac.test"), now)}`);
}
