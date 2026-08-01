import { wacBind } from "./harness/wacBind.ts";
const m = await wacBind("packages/tls/test/wac/probe.wac");
const leaf = await Deno.readFile("packages/tls/test/data/server.der");
const caPem = await Deno.readTextFile("packages/tls/test/data/ca.pem");
const ca = Uint8Array.from(atob(caPem.replace(/-----[^-]+-----|\s/g, "")), c => c.charCodeAt(0));
const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b).map(x=>x.toString(16).padStart(2,"0")).join("");
const parse = m.x509Parse as (d: Uint8Array) => Uint8Array;
for (const [name, der] of [["leaf", leaf], ["ca", ca]] as const) {
  const f = parse(der);
  const dv = new DataView(f.buffer, f.byteOffset);
  const nb = dv.getBigInt64(0), na = dv.getBigInt64(8);
  const dnsLen = (f[49]<<8)|f[50];
  console.log(`${name}: notBefore=${new Date(Number(nb)*1000).toISOString().slice(0,19)} notAfter=${new Date(Number(na)*1000).toISOString().slice(0,10)} isCa=${f[16]===1} key=${hex(f.subarray(17,49)).slice(0,16)}… dns=${JSON.stringify(new TextDecoder().decode(f.subarray(51,51+dnsLen)))}`);
}
console.log("leaf signed by ca:", (m.x509SignedBy as (a:Uint8Array,b:Uint8Array)=>boolean)(leaf, ca));
const now = BigInt(Math.floor(Date.now()/1000));
for (const h of ["wac.test", "WAC.TEST", "localhost", "evil.test", "ac.test"]) {
  console.log(`verifyChain(${h}) = ${(m.x509VerifyChain as (a:Uint8Array,b:Uint8Array,h:Uint8Array,n:bigint)=>number)(leaf, ca, enc.encode(h), now)}`);
}
