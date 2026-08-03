// A stream inside a circuit, shaped like a socket.
//
// This is the whole integration surface. Everything above Tor — TLS, HTTP, anything else
// that takes a connection — already knows how to talk to a socket, so the useful thing for
// this package to expose is not a new API but the shape those callers already accept.
//
// `Deno.Conn`'s read/write/close is that shape, and matching it exactly means no adapter at
// any boundary: `TlsStream.over(torSocket, ...)` and the HTTP client's `requestOver` both
// take it as-is, having never heard of Tor.

import type { Socket } from "../../tls/host/connect.ts";
import type { Circuit } from "./circuit.ts";
import type { CircuitPool } from "./pool.ts";

/**
 * One stream on a circuit, as a socket.
 *
 * The buffering exists because the two sides disagree about who owns memory: a circuit
 * hands over whole relay cells, and a socket reader asks for however much fits in the
 * buffer it brought. Anything left over is kept for the next read rather than dropped,
 * which is the bug this class exists to not have.
 */
export class TorSocket implements Socket {
  #circuit: Circuit;
  #streamId: number;
  #pending: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  #eof = false;
  #closed = false;

  constructor(circuit: Circuit, streamId: number) {
    this.#circuit = circuit;
    this.#streamId = streamId;
  }

  get circuit(): Circuit {
    return this.#circuit;
  }

  get streamId(): number {
    return this.#streamId;
  }

  async read(p: Uint8Array): Promise<number | null> {
    while (this.#pending.length === 0) {
      if (this.#eof) return null;
      const chunk = await this.#circuit.read(this.#streamId);
      if (chunk === null) {
        this.#eof = true;
        return null;
      }
      this.#pending = chunk as Uint8Array<ArrayBuffer>;
    }
    const n = Math.min(p.length, this.#pending.length);
    p.set(this.#pending.subarray(0, n));
    this.#pending = this.#pending.slice(n);
    return n;
  }

  /** Always writes everything: `Circuit.write` splits across cells and does not short-write. */
  async write(p: Uint8Array): Promise<number> {
    await this.#circuit.write(this.#streamId, p);
    return p.length;
  }

  /**
   * Send RELAY_END so the exit closes its TCP connection instead of waiting for a timeout.
   *
   * Synchronous to match `Socket`, so the cell goes out on a promise nobody awaits — the
   * same trade `TlsStream.close` makes, and for the same reason.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#circuit.endStream(this.#streamId).catch(() => {});
  }
}

/** Open a stream to `host:port` through the pool, as a socket. */
export async function torConnect(
  pool: CircuitPool, host: string, port: number, isolation = "default",
): Promise<TorSocket> {
  const { circuit, streamId } = await pool.stream(`${host}:${port}`, isolation);
  return new TorSocket(circuit, streamId);
}
