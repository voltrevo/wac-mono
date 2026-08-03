// The Tor link handshake, driven from the host.
//
// tor-spec §4. Over a TLS connection to a relay:
//
//   ->  VERSIONS
//   <-  VERSIONS, CERTS, AUTH_CHALLENGE, NETINFO
//   ->  NETINFO
//
// and the link is up. A client sends no AUTHENTICATE: relay-to-client authentication is
// what the ntor handshake does, against an onion key taken from the consensus, so proving
// possession of the TLS certificate would prove nothing anybody needs.
//
// This lives in TypeScript because it owns a socket, the same way `tls/host/connect.ts`
// does. Every byte layout is in `src/cell.wac`; what is here is the loop.

import { wacBind } from "../../../harness/wacBind.ts";
import { noTrustStore, TlsStream } from "../../tls/host/connect.ts";

const mod = await wacBind("packages/tor/test/wac/link_probe.wac");
const encodeVersions = mod.encodeVersions as (v: Int32Array) => Uint8Array;
const negotiate = mod.negotiate as (theirs: Uint8Array, ours: Int32Array) => number;
const encodeNetinfo = mod.encodeNetinfo as (ip: Uint8Array) => Uint8Array;
const cellSize = mod.cellSize as (buf: Uint8Array, at: number) => number;
const cellCommand = mod.cellCommand as (buf: Uint8Array, at: number) => number;
const cellPayload = mod.cellPayload as (buf: Uint8Array, at: number) => Uint8Array;
const certsCount = mod.certsCount as (payload: Uint8Array) => number;

export const encodeCreate2 = mod.encodeCreate2 as (circ: number, hs: Uint8Array) => Uint8Array;
export const decodeCreated2 = mod.decodeCreated2 as (payload: Uint8Array) => Uint8Array;

export const CMD = {
  relay: 3, destroy: 4, versions: 7, netinfo: 8, relayEarly: 9, create2: 10, created2: 11,
  vpadding: 128, certs: 129, authChallenge: 130,
} as const;

/**
 * A TLS connection to a relay, with no certificate validation.
 *
 * Tor relays present a self-signed certificate with a randomly generated CN and are
 * authenticated by the ntor handshake against an onion key from the consensus. Validating
 * the certificate would fail, and passing would mean nothing — so the trust store is
 * empty, which `client.wac` reads as "do not build a path".
 *
 * Deno's own TLS client cannot express this: it has no way to turn validation off, so an
 * empty `caCerts` still checks against the system roots and rejects the relay. Ours can,
 * which is the reason it is used here rather than merely being available.
 */
export async function connectRelay(host: string, port: number): Promise<TlsStream> {
  return await TlsStream.connect(host, port, host, noTrustStore());
}

type Buffered = { data: Uint8Array };

/** Read until one whole cell has arrived, then hand it back and consume it. */
export async function readCell(conn: TlsStream, buf: Buffered): Promise<Uint8Array | null> {
  for (;;) {
    if (buf.data.length > 0) {
      const n = cellSize(buf.data, 0);
      if (n > 0) {
        const cell = buf.data.slice(0, n);
        buf.data = buf.data.slice(n);
        return cell;
      }
    }
    const chunk = new Uint8Array(8192);
    const got = await conn.read(chunk);
    if (got === null) return null;
    const merged = new Uint8Array(buf.data.length + got);
    merged.set(buf.data);
    merged.set(chunk.subarray(0, got), buf.data.length);
    buf.data = merged;
  }
}

export type Link = {
  conn: TlsStream;
  version: number;
  certsSeen: number;
  buf: Buffered;
};

/** Do the link handshake and leave the connection ready for CREATE2. */
export async function linkHandshake(host: string, port: number): Promise<Link> {
  const conn = await connectRelay(host, port);
  const buf: Buffered = { data: new Uint8Array(0) };

  await conn.write(encodeVersions(Int32Array.from([3, 4, 5])));

  const theirVersions = await readCell(conn, buf);
  if (theirVersions === null) throw new Error("relay closed before sending VERSIONS");
  if (cellCommand(theirVersions, 0) !== CMD.versions) {
    throw new Error(`expected VERSIONS, got command ${cellCommand(theirVersions, 0)}`);
  }
  const version = negotiate(cellPayload(theirVersions, 0), Int32Array.from([3, 4, 5]));
  if (version < 4) throw new Error(`no usable link version (negotiated ${version})`);

  // CERTS, AUTH_CHALLENGE and NETINFO follow, with VPADDING allowed between them. Read
  // until NETINFO, which is the cell that says the relay has finished its half.
  let certsSeen = 0;
  for (;;) {
    const cell = await readCell(conn, buf);
    if (cell === null) throw new Error("relay closed during the handshake");
    const cmd = cellCommand(cell, 0);
    if (cmd === CMD.certs) {
      certsSeen = certsCount(cellPayload(cell, 0));
      if (certsSeen < 0) throw new Error("malformed CERTS cell");
    } else if (cmd === CMD.netinfo) {
      break;
    } else if (cmd !== CMD.authChallenge && cmd !== CMD.vpadding) {
      throw new Error(`unexpected command ${cmd} during the link handshake`);
    }
  }

  // Our NETINFO closes it: the address we saw them at, none of our own, and a zero clock.
  const octets = host.split(".").map(Number);
  const ip = octets.length === 4 && octets.every((n) => n >= 0 && n <= 255)
    ? Uint8Array.from(octets)
    : Uint8Array.from([127, 0, 0, 1]);
  await conn.write(encodeNetinfo(ip));
  return { conn, version, certsSeen, buf };
}

// ── Circuits ─────────────────────────────────────────────────────────────────

const ntorClientRequest = mod.ntorClientRequest as (
  identity: Uint8Array, onionKey: Uint8Array, ephemeralPriv: Uint8Array,
) => Uint8Array;
const ntorClientFinish = mod.ntorClientFinish as (
  identity: Uint8Array, onionKey: Uint8Array, ephemeralPriv: Uint8Array,
  reply: Uint8Array, keyLen: number,
) => Uint8Array;

/**
 * The key material one hop needs: Df | Db | Kf | Kb, per tor-spec §5.2.2.
 *
 * Two 20-byte SHA-1 digest seeds and two 16-byte AES keys, one of each per direction. The
 * digests are running hashes over everything sent that way, which is why they are seeded
 * rather than derived per cell.
 */
export const HOP_KEY_LEN = 72;

export type Hop = {
  circId: number;
  /** Df | Db | Kf | Kb — see HOP_KEY_LEN. */
  keys: Uint8Array;
};

/**
 * CREATE2 with an ntor handshake, and the keys that come back.
 *
 * The circuit id has its high bit set because we opened the connection. Both ends allocate
 * circuit ids on the same link, and the rule that the initiator uses the high half is what
 * stops the two of them choosing the same number — tor-spec §5.1.1.
 */
export async function createCircuit(link: Link, relay: {
  identity: Uint8Array;
  ntorOnionKey: Uint8Array;
}): Promise<Hop> {
  const circId = 0x80000000 | (1 + Math.floor(Math.random() * 0x7FFFFFFE));
  const ephemeralPriv = crypto.getRandomValues(new Uint8Array(32));
  const request = ntorClientRequest(relay.identity, relay.ntorOnionKey, ephemeralPriv);
  await link.conn.write(encodeCreate2(circId, request));

  const cell = await readCell(link.conn, link.buf);
  if (cell === null) throw new Error("relay closed instead of answering CREATE2");
  const cmd = cellCommand(cell, 0);
  if (cmd === CMD.destroy) {
    throw new Error(`relay refused the circuit: DESTROY reason ${cellPayload(cell, 0)[0]}`);
  }
  if (cmd !== CMD.created2) throw new Error(`expected CREATED2, got command ${cmd}`);

  const reply = decodeCreated2(cellPayload(cell, 0));
  const keys = ntorClientFinish(
    relay.identity, relay.ntorOnionKey, ephemeralPriv, reply, HOP_KEY_LEN,
  );
  // An empty return is how the handshake reports failure: either the AUTH value did not
  // match, or the relay's public key was a small-order point. Both mean the party at the
  // other end does not hold the private key the consensus says it should, so there is
  // nothing to negotiate and no reason to keep the connection.
  if (keys.length === 0) throw new Error("ntor handshake failed: the relay did not authenticate");
  return { circId, keys };
}
