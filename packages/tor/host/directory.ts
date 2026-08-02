// Reading the Tor directory: which relays exist, and what keys they use.
//
// ## What this does not do yet
//
// A real client verifies the consensus before believing it: it checks that a majority of
// the directory authorities signed it, using authority identity keys that are compiled
// into the client rather than fetched. Skipping that step means anyone who can answer a
// directory request can name the relays you use and the keys you use to talk to them,
// which defeats the point of the network.
//
// This parses a consensus that came from somewhere already trusted — a local testnet whose
// files are on the same disk. It is enough to build a circuit and see that the handshake,
// the framing and the relay crypto are right, and it is not enough to be a Tor client.
// Consensus signature verification is issue 0003 in this package.
//
// ## Microdescriptors
//
// The consensus a client downloads is the *microdescriptor* flavour: each relay's entry is
// a couple of lines plus the SHA-256 digest of a small separate document holding its keys.
// The split exists because the keys are the bulk of the data and change far less often than
// the flags and bandwidth do, so a client re-downloads the consensus hourly and the
// microdescriptors almost never.

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

/** Relays from a running chutney network's on-disk cache, with their onion keys filled in. */
export async function relaysFromChutney(nodeDir: string): Promise<Relay[]> {
  const consensus = await Deno.readTextFile(`${nodeDir}/cached-microdesc-consensus`);
  const relays = parseConsensus(consensus);
  const micros = await parseMicrodescriptors(
    await Deno.readTextFile(`${nodeDir}/cached-microdescs.new`)
      .catch(() => Deno.readTextFile(`${nodeDir}/cached-microdescs`)),
  );
  for (const r of relays) r.ntorOnionKey = micros.get(r.microdescDigest);
  return relays;
}
