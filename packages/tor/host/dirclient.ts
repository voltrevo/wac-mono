// Fetching the directory over Tor, instead of reading it off disk.
//
// ## The bootstrap problem, and why it is not circular
//
// To build a circuit you need relay keys. To get relay keys you need the directory. To
// fetch the directory privately you want a circuit. That looks circular and is not, because
// the first fetch does not need to be private — the consensus is a public document that
// every client has, and downloading it reveals only that you are a Tor user, which your
// connection to a relay revealed anyway.
//
// So a real client ships with a hardcoded list of authorities and fallback directory
// mirrors, connects to one *directly* for its first consensus, and uses circuits afterwards.
// The privacy that matters is not in hiding the consensus download; it is in everything
// after it, and in the verification that makes the download's source irrelevant.
//
// This does the same. `bootstrap` takes a starting relay — the caller's stand-in for a
// hardcoded fallback — and everything after that goes over circuits.
//
// ## BEGIN_DIR
//
// A directory request is a stream to the relay's own directory cache rather than to a TCP
// address, so it needs no exit and no exit policy. That makes it the one stream a one-hop
// circuit can always open, which is exactly what a bootstrap needs.

import { Circuit } from "./circuit.ts";
import { createCircuit, linkHandshake, type Link } from "./link.ts";
import {
  attachMicrodescriptors, chutneyAuthorities, parseConsensus, parseMicrodescriptors,
  type Relay,
} from "./directory.ts";
import { parseCertificates, verifyConsensus } from "./verify.ts";
import { PathChooser } from "./path.ts";

/** Where a directory request can be sent, before we have a consensus naming anyone. */
export type DirectoryStart = {
  address: string;
  orPort: number;
  identity: Uint8Array;
  ntorOnionKey: Uint8Array;
};

/**
 * Split an HTTP/1.0 response into status and body.
 *
 * Directory responses are simple enough not to want a real HTTP client: no chunking, no
 * keep-alive, and the stream ends when the body does. `Content-Length` is not even always
 * present, which is why the body is "whatever arrived" rather than a counted read.
 */
function splitResponse(bytes: Uint8Array): { status: number; headers: string; body: Uint8Array } {
  const marker = new TextEncoder().encode("\r\n\r\n");
  let at = -1;
  outer:
  for (let i = 0; i + 4 <= bytes.length; i++) {
    for (let j = 0; j < 4; j++) if (bytes[i + j] !== marker[j]) continue outer;
    at = i;
    break;
  }
  if (at < 0) throw new Error("directory response had no header terminator");
  const headers = new TextDecoder().decode(bytes.subarray(0, at));
  const status = Number(headers.split(" ")[1] ?? "0");
  return { status, headers, body: bytes.subarray(at + 4) };
}

async function inflate(body: Uint8Array, headers: string): Promise<Uint8Array> {
  const enc = headers.match(/^content-encoding: (\S+)/im)?.[1]?.toLowerCase() ?? "identity";
  if (enc === "identity") return body;
  if (enc !== "deflate" && enc !== "gzip" && enc !== "x-gzip") {
    throw new Error(`directory sent an encoding we did not ask for: ${enc}`);
  }
  const format = enc === "deflate" ? "deflate" : "gzip";
  const stream = new Blob([body as BlobPart]).stream()
    .pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * GET a directory document through an already-built circuit.
 *
 * `Accept-Encoding: identity` because the point here is the Tor plumbing, not the
 * compression — and a directory cache that ignores it and compresses anyway is handled
 * rather than trusted to behave.
 */
export async function fetchOverCircuit(circ: Circuit, path: string): Promise<Uint8Array> {
  const streamId = await circ.beginDir();
  await circ.write(
    streamId,
    new TextEncoder().encode(
      `GET ${path} HTTP/1.0\r\nAccept-Encoding: identity\r\n\r\n`,
    ),
  );
  const raw = await circ.readToEnd(streamId);
  const { status, headers, body } = splitResponse(raw);
  if (status !== 200) {
    throw new Error(`directory returned ${status} for ${path}`);
  }
  return await inflate(body, headers);
}

/** The URL for a batch of microdescriptors, keyed by their base64 digests. */
export function microdescPath(digests: string[]): string {
  // Tor separates them with "-" and expects the unpadded base64 straight from the `m` lines.
  return `/tor/micro/d/${digests.join("-")}`;
}

export type Bootstrapped = {
  relays: Relay[];
  chooser: PathChooser;
  consensus: string;
  link: Link;
  circuit: Circuit;
};

/**
 * Fetch and verify a consensus over Tor, and come back able to build paths.
 *
 * The one-hop circuit to `start` is the part a real client would make to a hardcoded
 * fallback. Everything the function returns has been through `verifyConsensus`, so the
 * relay it came from does not have to be trusted — which is the property that makes the
 * unencrypted-looking bootstrap acceptable in the first place.
 */
export async function bootstrap(
  start: DirectoryStart, trusted: Set<string>, now?: number,
): Promise<Bootstrapped> {
  if (trusted.size === 0) {
    throw new Error("no trusted authorities: the fetched consensus could not be checked");
  }
  const link = await linkHandshake(start.address, start.orPort);
  const hop = await createCircuit(link, start);
  const circuit = new Circuit(link, hop.circId, hop.keys);

  const dec = new TextDecoder();
  const consensus = dec.decode(
    await fetchOverCircuit(circuit, "/tor/status-vote/current/consensus-microdesc"),
  );
  // The certificates naming the signing keys. Asking for all of them by authority
  // fingerprint rather than taking whatever the cache volunteers: we know which authorities
  // we trust, and a cache that omits one should look like a missing signature rather than
  // like an authority that does not exist.
  const certs = dec.decode(await fetchOverCircuit(
    circuit,
    `/tor/keys/fp/${[...trusted].join("+")}`,
  ));

  const verdict = verifyConsensus(consensus, parseCertificates(certs, trusted), trusted, now);
  if (!verdict.ok) {
    const why = verdict.stale ?? `${verdict.signedBy.length} of ${verdict.needed} signatures`;
    throw new Error(`the consensus we fetched is not acceptable: ${why}`);
  }

  const relays = parseConsensus(consensus);
  // Microdescriptors in one request. A real client batches to keep URLs under the cache's
  // limit; with a testnet's handful there is only one batch, and the loop is here so that
  // is a property of the data rather than of the code.
  const micros = new Map<string, Awaited<ReturnType<typeof parseMicrodescriptors>> extends
    Map<string, infer V> ? V : never>();
  const digests = relays.map((r) => r.microdescDigest).filter((d) => d !== "");
  for (let i = 0; i < digests.length; i += 92) {
    const batch = digests.slice(i, i + 92);
    const text = dec.decode(await fetchOverCircuit(circuit, microdescPath(batch)));
    for (const [k, v] of await parseMicrodescriptors(text)) micros.set(k, v);
  }
  attachMicrodescriptors(relays, micros);

  return { relays, chooser: new PathChooser(relays, consensus), consensus, link, circuit };
}

export { chutneyAuthorities };

// ── Keeping the directory current ────────────────────────────────────────────

/**
 * When to fetch the next consensus, as a unix time — or null if this one has no schedule.
 *
 * dir-spec §5.1. Not "when the current one expires": every client would then hit the caches
 * at the same instant, which is both a thundering herd and a fingerprint, since a client
 * that downloads at a distinctive moment is distinguishable. So the time is chosen uniformly
 * in a window opening at `fresh-until` and closing three quarters of the way to
 * `valid-until`, leaving a quarter of the interval as slack for the download to fail and be
 * retried before anything expires.
 */
export function refreshAt(
  consensus: string, random: () => number = Math.random,
): number | null {
  const at = (field: string) => {
    const m = consensus.match(new RegExp(`^${field} (.+)$`, "m"));
    if (m === null) return null;
    const t = m[1].match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    return t === null
      ? null
      : Date.UTC(+t[1], +t[2] - 1, +t[3], +t[4], +t[5], +t[6]) / 1000;
  };
  const fresh = at("fresh-until");
  const valid = at("valid-until");
  if (fresh === null || valid === null || valid <= fresh) return null;
  return Math.floor(fresh + random() * (valid - fresh) * 0.75);
}

/** Unix time when a consensus stops being acceptable at all. */
export function validUntil(consensus: string): number | null {
  const m = consensus.match(/^valid-until (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/m);
  return m === null
    ? null
    : Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
}

/**
 * A consensus that keeps itself current.
 *
 * Two rules that matter more than the refreshing does.
 *
 * A failed refresh keeps the old consensus rather than falling back to anything unverified.
 * An attacker who can break your directory fetches should get a client running on stale but
 * genuine data, not one that shrugs and believes the next thing it is handed.
 *
 * Once the current consensus is past `valid-until` with no replacement, `chooser` throws.
 * Continuing to build paths from an expired document is how a replay of last year's
 * consensus would work — the relays in it may be long gone, and their keys may not be.
 */
export class Directory {
  #consensus: string;
  #chooser: PathChooser;
  #relays: Relay[];
  #trusted: Set<string>;
  #refreshAt: number;
  #validUntil: number;

  private constructor(
    consensus: string, relays: Relay[], trusted: Set<string>, random: () => number,
  ) {
    this.#consensus = consensus;
    this.#relays = relays;
    this.#chooser = new PathChooser(relays, consensus);
    this.#trusted = trusted;
    this.#refreshAt = refreshAt(consensus, random) ?? Infinity;
    this.#validUntil = validUntil(consensus) ?? Infinity;
  }

  static fromBootstrap(
    boot: Bootstrapped, trusted: Set<string>, random: () => number = Math.random,
  ): Directory {
    return new Directory(boot.consensus, boot.relays, trusted, random);
  }

  get relays(): Relay[] {
    return this.#relays;
  }

  get expiresAt(): number {
    return this.#validUntil;
  }

  /** The chooser, if the consensus behind it is still valid. */
  chooser(now: number = Math.floor(Date.now() / 1000)): PathChooser {
    if (now > this.#validUntil) {
      throw new Error(
        "the consensus has expired and no replacement was fetched; " +
        "building paths from it would mean trusting a document the authorities have retired",
      );
    }
    return this.#chooser;
  }

  /** Whether it is time to go and get a new one. */
  dueForRefresh(now: number = Math.floor(Date.now() / 1000)): boolean {
    return now >= this.#refreshAt;
  }

  /**
   * Fetch a replacement over `circ` if one is due.
   *
   * Returns whether anything changed. A refusal to verify is reported by throwing, because
   * it is the interesting case: the caller has just been handed a document that did not
   * check out, and swallowing that would leave a client quietly running on data it should
   * have been alarmed about.
   */
  async refresh(
    circ: Circuit, now: number = Math.floor(Date.now() / 1000),
    random: () => number = Math.random,
  ): Promise<boolean> {
    if (!this.dueForRefresh(now)) return false;
    const dec = new TextDecoder();
    const consensus = dec.decode(
      await fetchOverCircuit(circ, "/tor/status-vote/current/consensus-microdesc"),
    );
    const certs = dec.decode(
      await fetchOverCircuit(circ, `/tor/keys/fp/${[...this.#trusted].join("+")}`),
    );
    const verdict = verifyConsensus(
      consensus, parseCertificates(certs, this.#trusted), this.#trusted, now,
    );
    if (!verdict.ok) {
      const why = verdict.stale ?? `${verdict.signedBy.length} of ${verdict.needed} signatures`;
      throw new Error(`the replacement consensus is not acceptable: ${why}`);
    }
    // Only now is anything replaced. Parsing into the live fields before verifying would
    // mean a rejected document had already half-arrived.
    const relays = parseConsensus(consensus);
    const digests = relays.map((r) => r.microdescDigest).filter((d) => d !== "");
    const micros = new Map<string, Awaited<ReturnType<typeof parseMicrodescriptors>> extends
      Map<string, infer V> ? V : never>();
    for (let i = 0; i < digests.length; i += 92) {
      const text = dec.decode(
        await fetchOverCircuit(circ, microdescPath(digests.slice(i, i + 92))),
      );
      for (const [k, v] of await parseMicrodescriptors(text)) micros.set(k, v);
    }
    attachMicrodescriptors(relays, micros);

    this.#consensus = consensus;
    this.#relays = relays;
    this.#chooser = new PathChooser(relays, consensus);
    this.#refreshAt = refreshAt(consensus, random) ?? Infinity;
    this.#validUntil = validUntil(consensus) ?? Infinity;
    return true;
  }
}
