// Runs the wac directory parser against the TypeScript one it replaces.
//
// A differential during a port is the one time the outgoing implementation earns its keep:
// it encodes every case that was ever fixed in it, including those nobody wrote a test for.
// The expected values are computed by `host/directory.ts` at test time rather than baked
// in, so the two cannot drift apart silently — when the TypeScript goes, these become fixed
// vectors and the comment above them should say so.
//
// The documents are built here rather than captured, because the chutney testnet lives in
// /tmp and does not survive a container recreation. They are shaped like the real thing:
// an authority that exits nowhere, a relay that exits everywhere, a declared family, and a
// relay whose microdescriptor never arrives.

import { wacTestRun } from "../../../harness/wacTestRun.ts";
import { attachMicrodescriptors, parseConsensus, parseMicrodescriptors } from "../host/directory.ts";

const enc = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/=+$/, "");
const sha256 = async (b: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));

const identity = (seed: number) =>
  b64(Uint8Array.from({ length: 20 }, (_, i) => (seed * 37 + i * 11) & 0xFF));
const onionKey = (seed: number) =>
  b64(Uint8Array.from({ length: 32 }, (_, i) => (seed * 53 + i * 7) & 0xFF));

// Four microdescriptors. The authority has no `p` line at all, which is how a consensus
// says "exits nowhere"; two declare each other family; the fourth is never served.
const micros = [
  `onion-key\nntor-onion-key ${onionKey(1)}\nid ed25519 ${identity(11)}\n`,
  `onion-key\nntor-onion-key ${onionKey(2)}\nfamily gamma\np accept 1-65535\n`,
  `onion-key\nntor-onion-key ${onionKey(3)}\nfamily beta\np accept 80,443,8000-8100\n`,
  `onion-key\nntor-onion-key ${onionKey(4)}\np reject 1-65535\n`,
];
const digests = await Promise.all(micros.map((m) => sha256(enc.encode(m)).then(b64)));

const names = ["alpha", "beta", "gamma", "delta"];
const flags = [
  "Authority Fast Running Stable V2Dir Valid",
  "Exit Fast Guard HSDir Running Stable Valid",
  "Exit Fast Guard Running Stable Valid",
  "Fast Running Valid",
];
const consensus = [
  "network-status-version 3 microdesc",
  "valid-after 2026-08-03 10:00:00",
  "fresh-until 2026-08-03 11:00:00",
  "valid-until 2026-08-03 13:00:00",
  ...names.flatMap((n, i) => [
    `r ${n} ${identity(i + 1)} 2026-08-03 09:00:00 10.${i}.0.1 ${9001 + i} 0`,
    `m ${digests[i]}`,
    `s ${flags[i]}`,
    `v Tor 0.4.7.13`,
    `w Bandwidth=${(i + 1) * 100} Unmeasured=1`,
  ]),
  "directory-signature sha256 AAAA BBBB",
  "-----BEGIN SIGNATURE-----",
  "not a real signature",
  "-----END SIGNATURE-----",
  "",
].join("\n");

// Only the first three are served, so `delta` keeps an unmatched digest — the case where a
// relay is listed but unusable.
const microText = micros.slice(0, 3).map((m) => `@last-listed 2026-08-03\n${m}`).join("");

// The oracle: what the TypeScript makes of the same bytes.
const relays = parseConsensus(consensus);
const summary = relays.map((r) =>
  `${r.nickname}|${r.address}|${r.orPort}|${r.flags.join(",")}|${r.microdescDigest}|` +
  // bandwidth is not on the TS Relay type; it is read straight from the document
  (consensus.match(new RegExp(`^r ${r.nickname} [\\s\\S]*?^w Bandwidth=(\\d+)`, "m"))?.[1] ?? "0")
).join("\n") + "\n";

attachMicrodescriptors(relays, await parseMicrodescriptors(microText));
const keys = relays.map((r) => {
  const p = r.exitPolicy;
  const policy = p === undefined
    ? "none"
    : (p.isAccept ? "accept" : "reject") +
      p.ranges.reduce((s, v, i) => i % 2 === 0 ? `${s} ${v}` : `${s}-${v}`, "");
  return `${r.nickname}|${r.ntorOnionKey ? b64(r.ntorOnionKey) : ""}|${policy}|` +
    (r.family ?? []).join(",");
}).join("\n") + "\n";

const fixtures = [enc.encode(consensus), enc.encode(microText), enc.encode(summary), enc.encode(keys)];

await wacTestRun("packages/tor/test/wac/directory_test.wac", "directory",
  [(n: number) => fixtures[n]]);
