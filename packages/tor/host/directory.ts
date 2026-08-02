// Reading the Tor directory: which relays exist, and what keys they use.
//
// ## Parsing is not believing
//
// `parseConsensus` reads a document. It says nothing about whether the document is genuine,
// and on its own it is not safe to build a circuit from: anyone who can answer a directory
// request could name the relays you use and the keys you use to talk to them.
//
// `verifyConsensus` in `verify.ts` is the part that decides. Use `relaysFromVerified` below
// rather than calling the parser directly, unless you specifically want the unchecked
// document — and if you do, name the variable so the next reader can see that you meant it.
//
// ## Microdescriptors
//
// The consensus a client downloads is the *microdescriptor* flavour: each relay's entry is
// a couple of lines plus the SHA-256 digest of a small separate document holding its keys.
// The split exists because the keys are the bulk of the data and change far less often than
// the flags and bandwidth do, so a client re-downloads the consensus hourly and the
// microdescriptors almost never.

import { parseCertificates, verifyConsensus } from "./verify.ts";

/** A relay, with everything needed to open a circuit through it. */
export type Relay = {
  nickname: string;
  identity: Uint8Array; // 20 bytes: SHA-1 of its RSA identity key
  address: string;
  orPort: number;
  flags: string[];
  microdescDigest: string; // base64, unpadded — the key into the microdescriptor set
  ntorOnionKey?: Uint8Array; // 32 bytes, once the microdescriptor is matched up
};

function b64(s: string): Uint8Array {
  // Directory documents use unpadded base64 throughout, which atob rejects.
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Every relay in a microdescriptor-flavour consensus. */
export function parseConsensus(text: string): Relay[] {
  const relays: Relay[] = [];
  let current: Relay | null = null;
  for (const line of text.split("\n")) {
    const f = line.split(" ");
    if (f[0] === "r" && f.length >= 8) {
      // r <nickname> <identity> <published date> <time> <IP> <ORPort> <DirPort>
      current = {
        nickname: f[1],
        identity: b64(f[2]),
        address: f[5],
        orPort: Number(f[6]),
        flags: [],
        microdescDigest: "",
      };
      relays.push(current);
    } else if (current === null) {
      continue;
    } else if (f[0] === "m" && f.length >= 2) {
      current.microdescDigest = f[1];
    } else if (f[0] === "s") {
      current.flags = f.slice(1);
    }
  }
  return relays;
}

/**
 * ntor onion keys from a microdescriptor cache, keyed by each descriptor's SHA-256 digest.
 *
 * The digest is computed over the microdescriptor text rather than read from it, because
 * that is the only thing tying a key to the consensus entry that named it. Trusting the
 * cache's own `@`-prefixed annotations instead would mean a relay could serve a
 * microdescriptor holding somebody else's key.
 */
export async function parseMicrodescriptors(text: string): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  // Each microdescriptor starts at an "onion-key" line; the cache file interleaves
  // "@last-listed" annotations that are not part of the digested text.
  const lines = text.split("\n");
  let start = -1;
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "onion-key") {
      if (start >= 0) bodies.push(lines.slice(start, i).filter((l) => !l.startsWith("@")).join("\n"));
      start = i;
    }
  }
  if (start >= 0) bodies.push(lines.slice(start).filter((l) => !l.startsWith("@")).join("\n"));

  for (let body of bodies) {
    body = body.replace(/\n+$/, "") + "\n";
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    );
    const key = body.match(/^ntor-onion-key (\S+)/m);
    if (key === null) continue;
    out.set(btoa(String.fromCharCode(...digest)).replace(/=+$/, ""), b64(key[1]));
  }
  return out;
}

/**
 * Relays from a consensus, but only if a majority of the trusted authorities signed it.
 *
 * Throws rather than returning an empty list. A caller that got no relays back would
 * reasonably try another directory; a caller whose consensus failed verification has been
 * lied to, and the two should not look the same.
 */
export async function relaysFromVerified(
  consensus: string, certsText: string, microdescs: string, trusted: Set<string>,
): Promise<Relay[]> {
  if (trusted.size === 0) {
    throw new Error("no trusted authorities: verification would be vacuous");
  }
  const certs = parseCertificates(certsText, trusted);
  const verdict = verifyConsensus(consensus, certs, trusted);
  if (!verdict.ok) {
    const why = verdict.rejected.map((r) => `${r.fingerprint.slice(0, 8)}: ${r.why}`).join("; ");
    throw new Error(
      `consensus not accepted: ${verdict.signedBy.length} good signatures, ` +
      `${verdict.needed} needed${why === "" ? "" : ` (${why})`}`,
    );
  }
  const relays = parseConsensus(consensus);
  const micros = await parseMicrodescriptors(microdescs);
  for (const r of relays) r.ntorOnionKey = micros.get(r.microdescDigest);
  return relays;
}

/**
 * Relays from a running chutney network's on-disk cache.
 *
 * Verified when `trusted` is given, and not otherwise — the unchecked form stays available
 * because a testnet's authority fingerprints are generated fresh on every run and a caller
 * poking at cell framing has no reason to gather them.
 */
export async function relaysFromChutney(
  nodeDir: string, trusted?: Set<string>,
): Promise<Relay[]> {
  const consensus = await Deno.readTextFile(`${nodeDir}/cached-microdesc-consensus`);
  const microdescs = await Deno.readTextFile(`${nodeDir}/cached-microdescs.new`)
    .catch(() => Deno.readTextFile(`${nodeDir}/cached-microdescs`));
  if (trusted !== undefined) {
    return await relaysFromVerified(
      consensus, await Deno.readTextFile(`${nodeDir}/cached-certs`), microdescs, trusted,
    );
  }
  const relays = parseConsensus(consensus);
  const micros = await parseMicrodescriptors(microdescs);
  for (const r of relays) r.ntorOnionKey = micros.get(r.microdescDigest);
  return relays;
}

/** The authority fingerprints a chutney network generated for itself, for tests. */
export async function chutneyAuthorities(netDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  for await (const entry of Deno.readDir(netDir)) {
    if (!entry.isDirectory) continue;
    const text = await Deno.readTextFile(`${netDir}/${entry.name}/keys/authority_certificate`)
      .catch(() => "");
    const m = text.match(/^fingerprint ([0-9A-F]{40})/m);
    if (m !== null) out.add(m[1]);
  }
  return out;
}
