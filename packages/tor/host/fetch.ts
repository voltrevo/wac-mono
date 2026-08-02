// HTTPS over Tor.
//
// Almost nothing here, which is the point. A Tor stream is a socket (`TorSocket`), TLS runs
// over a socket and is itself a socket (`TlsStream`), and the HTTP client takes a socket
// (`requestOver`). So the whole thing is three lines of composition and no new request loop
// — the one in `packages/http` was already correct and general, and only its `Deno.connect`
// made it TCP-specific.
//
//   HTTP            packages/http     requestOver(socket, ...)
//   TLS 1.3         packages/tls      TlsStream.over(socket, ...)   <- is a socket
//   RELAY cells     packages/tor      TorSocket                     <- is a socket
//   TLS 1.3         packages/tls      client to guard
//   TCP
//
// ## The exit is the adversary, so certificate validation matters here
//
// Everywhere else in this package the trust store is deliberately empty: a relay's
// certificate is self-signed and its identity comes from ntor against a consensus key, so
// validating it would fail and passing would prove nothing.
//
// This is the exact opposite case. The exit relay sees plaintext TCP and can be anybody —
// running one is permissionless, and exits that tamper are a documented, observed thing.
// The only reason a request through one is safe is the end-to-end TLS, so the trust store
// here must be a real one and a failure must be fatal.
//
// Tor with an unvalidated end-to-end TLS is worse than no Tor: it takes a connection your
// ISP could read and hands it to a stranger who chose to be there.

import { pemBundle, TlsStream } from "../../tls/host/connect.ts";
import { type Options, requestOver, type Result } from "../../http/host/client.ts";
import type { CircuitPool } from "./pool.ts";
import { torConnect } from "./socket.ts";

let systemRoots: { der: Uint8Array; offsets: Int32Array } | null = null;

/**
 * The host's CA bundle, read once.
 *
 * A caller wanting a different set passes one: "which authorities do I trust" should be
 * answerable at the call site rather than being a property of the machine.
 */
export async function defaultRoots(): Promise<{ der: Uint8Array; offsets: Int32Array }> {
  if (systemRoots === null) {
    systemRoots = pemBundle(await Deno.readTextFile("/etc/ssl/certs/ca-certificates.crt"));
  }
  return systemRoots;
}

export type FetchOptions = Options & {
  /** Certificate authorities for the end-to-end TLS. Defaults to the host's bundle. */
  roots?: { der: Uint8Array; offsets: Int32Array };
  /** Streams that must not be linked must not share a circuit — see `CircuitPool`. */
  isolation?: string;
};

/**
 * Fetch an https:// URL through a circuit from `pool`.
 *
 * A plain http:// URL is refused rather than fetched. The exit would see and could rewrite
 * the whole thing, and a function that quietly allowed it would be the easiest possible way
 * to misuse this package.
 */
export async function torFetch(
  pool: CircuitPool, url: string, options: FetchOptions = {},
): Promise<Result> {
  const u = new URL(url);
  if (u.protocol !== "https:") {
    throw new Error(
      `torFetch refuses ${u.protocol}//: the exit relay can read and rewrite plain HTTP, ` +
      "and it is a stranger by design",
    );
  }
  const port = u.port === "" ? 443 : Number(u.port);
  const socket = await torConnect(pool, u.hostname, port, options.isolation ?? "default");
  try {
    // SNI and the certificate are both checked against the hostname, the same as any other
    // client. Nothing about Tor makes that weaker and the exit makes it more necessary.
    const tls = await TlsStream.over(socket, u.hostname, options.roots ?? await defaultRoots());
    const target = u.pathname + u.search;
    return await requestOver(tls, u.host, target === "" ? "/" : target, {
      ...options,
      // No keep-alive: the circuit is retired on a timer anyway, and a connection held open
      // to be reused later is a connection whose lifetime says something about the caller.
      keepAlive: false,
    });
  } finally {
    pool.release(socket.circuit);
  }
}
