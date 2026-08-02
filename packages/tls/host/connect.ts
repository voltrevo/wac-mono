// A TLS 1.3 client. The socket and the randomness live here; everything else is wac.
//
//   deno run -A packages/tls/host/connect.ts <host> <port> <ca.pem>

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/tls/test/wac/probe.wac");
const init = mod.cliInit as (
  h: Uint8Array, roots: Uint8Array, rootOffsets: Int32Array, e: Uint8Array,
  p256: Uint8Array, kemSeed: Uint8Array, r: Uint8Array, now: bigint,
) => Uint8Array;
const feedRaw = mod.cliFeed as (state: Uint8Array, input: Uint8Array) => Uint8Array;
const sendRaw = mod.cliSend as (state: Uint8Array, data: Uint8Array) => Uint8Array;
const closeRaw = mod.cliClose as (state: Uint8Array) => Uint8Array;
const phase = mod.cliPhase as (state: Uint8Array) => number;
const failure = mod.cliFailure as (state: Uint8Array) => number;

/**
 * A P-256 private scalar: 32 random bytes, retried until they land in [1, n).
 *
 * Rejection sampling rather than reduction, because reducing a uniform 256-bit value mod
 * n biases the low end. The rejection probability is about 2^-32, so this virtually
 * never loops.
 */
export function p256Scalar(): Uint8Array {
  const N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n;
  while (true) {
    const k = crypto.getRandomValues(new Uint8Array(32));
    let v = 0n;
    for (const b of k) v = (v << 8n) | BigInt(b);
    if (v > 0n && v < N) return k;
  }
}

export function unpack(r: Uint8Array): { state: Uint8Array; toSend: Uint8Array; appData: Uint8Array } {
  const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
  let p = 0;
  const take = () => {
    const n = dv.getUint32(p);
    p += 4;
    const b = r.slice(p, p + n);
    p += n;
    return b;
  };
  return { state: take(), toSend: take(), appData: take() };
}

/** Turn a PEM certificate into DER. */
export function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** A trust store: every certificate in a PEM bundle, concatenated with its offsets. */
export function pemBundle(pem: string): { der: Uint8Array; offsets: Int32Array } {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g) ?? [];
  const ders = blocks.map(pemToDer);
  const total = ders.reduce((n, d) => n + d.length, 0);
  const der = new Uint8Array(total);
  const offsets = new Int32Array(ders.length * 2);
  let at = 0;
  ders.forEach((d, i) => {
    offsets[2 * i] = at;
    der.set(d, at);
    at += d.length;
    offsets[2 * i + 1] = at;
  });
  return { der, offsets };
}

/** One certificate, as a trust store of one. */
export function singleRoot(der: Uint8Array): { der: Uint8Array; offsets: Int32Array } {
  return { der, offsets: Int32Array.from([0, der.length]) };
}

/**
 * Open a TCP stream to `host:port`, through an HTTP proxy when one is configured.
 *
 * This sandbox has no DNS and reaches the internet only through Squid, so a direct
 * `Deno.connect` to a real host fails at name resolution. The proxy takes a CONNECT and
 * then relays bytes untouched, which is exactly what TLS needs — and it stays on this
 * side of the boundary, because the socket was always the host's job.
 */
export async function openStream(host: string, port: number): Promise<Deno.Conn> {
  const proxy = Deno.env.get("HTTPS_PROXY") ?? Deno.env.get("https_proxy");
  // Loopback never goes through a proxy, and Squid refuses it outright — which is how
  // this first broke: routing everything through the proxy turned every local test into
  // a 403 that looked like a TLS failure.
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" ||
    host.startsWith("127.");
  if (!proxy || local) return await Deno.connect({ hostname: host, port });

  const u = new URL(proxy);
  const conn = await Deno.connect({ hostname: u.hostname, port: Number(u.port || 3128) });
  await conn.write(new TextEncoder().encode(
    `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
  // Read until the blank line that ends the proxy's response, and no further: anything
  // after it belongs to the tunnel and must not be swallowed.
  let head = "";
  const buf = new Uint8Array(1);
  while (!head.endsWith("\r\n\r\n")) {
    const n = await conn.read(buf);
    if (n === null) throw new Error("proxy closed during CONNECT");
    head += String.fromCharCode(buf[0]);
    if (head.length > 8192) throw new Error("proxy response too long");
  }
  const status = head.split(" ")[1];
  if (status !== "200") throw new Error(`proxy refused CONNECT: ${head.split("\r\n")[0]}`);
  return conn;
}

export { failure, feedRaw as feed, init, phase, closeRaw as close, sendRaw as send };

/**
 * Connect, handshake, send `request`, and return the first response.
 *
 * Records are handed to wac whole, the same discipline both servers use.
 */
export async function request(
  hostname: string, port: number, serverName: string,
  roots: Uint8Array | { der: Uint8Array; offsets: Int32Array }, req: string,
): Promise<{ response: string; failure: number }> {
  const store = roots instanceof Uint8Array ? singleRoot(roots) : roots;
  const conn = await openStream(hostname, port);
  const enc = new TextEncoder();
  let state: Uint8Array;
  {
    const r = unpack(init(
      enc.encode(serverName), store.der, store.offsets,
      crypto.getRandomValues(new Uint8Array(32)),
      p256Scalar(),
      crypto.getRandomValues(new Uint8Array(64)),   // the ML-KEM seed, d || z
      crypto.getRandomValues(new Uint8Array(32)),
      BigInt(Math.floor(Date.now() / 1000)),
    ));
    state = r.state;
    await conn.write(r.toSend);
  }

  let buf = new Uint8Array(0);
  const chunk = new Uint8Array(16640);
  let response = "";
  let sentRequest = false;
  try {
    while (true) {
      const n = await conn.read(chunk);
      if (n === null) break;
      const merged = new Uint8Array(buf.length + n);
      merged.set(buf);
      merged.set(chunk.subarray(0, n), buf.length);
      buf = merged;

      let consumed = 0;
      while (buf.length - consumed >= 5) {
        const need = 5 + ((buf[consumed + 3] << 8) | buf[consumed + 4]);
        if (buf.length - consumed < need) break;
        consumed += need;
      }
      if (consumed === 0) continue;
      const ready = buf.slice(0, consumed);
      buf = buf.slice(consumed);

      const r = unpack(feedRaw(state, ready));
      state = r.state;
      if (r.toSend.length > 0) await conn.write(r.toSend);
      if (r.appData.length > 0) response += new TextDecoder().decode(r.appData);
      if (failure(state) !== 0) break;

      if (phase(state) === 3 && !sentRequest) {
        sentRequest = true;
        const s = unpack(sendRaw(state, enc.encode(req)));
        state = s.state;
        await conn.write(s.toSend);
      }
      if (response.length > 0 && response.includes("\r\n\r\n")) break;
    }
  } finally {
    try { conn.close(); } catch { /* already closed */ }
  }
  return { response, failure: failure(state) };
}

/**
 * A TLS connection as a byte stream you can read and write in any order.
 *
 * `request` above is a one-shot: send this, read until the response ends. That is the
 * shape of HTTP and the wrong shape for anything else. A protocol like Tor's link layer
 * interleaves — the peer sends four cells unprompted, you answer one of them, and both
 * directions stay open indefinitely — so it needs the connection as a stream rather than
 * as a function call.
 *
 * The framing discipline is the same one `request` uses and both servers use: whole
 * records are handed to wac, never partial ones and never two half-records glued.
 */
export class TlsStream {
  #conn: Deno.Conn;
  #state: Uint8Array;
  #raw = new Uint8Array(0);        // bytes read from the socket, not yet whole records
  #plain = new Uint8Array(0);      // decrypted application data, not yet handed out
  #chunk = new Uint8Array(16640);
  #closed = false;

  private constructor(conn: Deno.Conn, state: Uint8Array) {
    this.#conn = conn;
    this.#state = state;
  }

  /** The connection's failure code: 0 while it is healthy. */
  get failure(): number {
    return failure(this.#state);
  }

  /**
   * Connect and complete the handshake.
   *
   * An empty trust store means "do not build a path" — see the note in `client.wac`. It is
   * what a Tor relay needs, since its certificate is self-signed and its identity is
   * established by the ntor handshake instead.
   */
  static async connect(
    hostname: string, port: number, serverName: string,
    roots: { der: Uint8Array; offsets: Int32Array },
  ): Promise<TlsStream> {
    const conn = await openStream(hostname, port);
    const r = unpack(init(
      new TextEncoder().encode(serverName), roots.der, roots.offsets,
      crypto.getRandomValues(new Uint8Array(32)),
      p256Scalar(),
      crypto.getRandomValues(new Uint8Array(64)),
      crypto.getRandomValues(new Uint8Array(32)),
      BigInt(Math.floor(Date.now() / 1000)),
    ));
    const s = new TlsStream(conn, r.state);
    await conn.write(r.toSend);
    while (phase(s.#state) !== 3) {
      if (!await s.#pump()) throw new Error("peer closed during the handshake");
      if (s.failure !== 0) throw new Error(`handshake failed, code ${s.failure}`);
    }
    return s;
  }

  /** Read once from the socket and feed every whole record to wac. False at end of stream. */
  async #pump(): Promise<boolean> {
    const n = await this.#conn.read(this.#chunk);
    if (n === null) return false;
    const merged = new Uint8Array(this.#raw.length + n);
    merged.set(this.#raw);
    merged.set(this.#chunk.subarray(0, n), this.#raw.length);
    this.#raw = merged;

    let consumed = 0;
    while (this.#raw.length - consumed >= 5) {
      const need = 5 + ((this.#raw[consumed + 3] << 8) | this.#raw[consumed + 4]);
      if (this.#raw.length - consumed < need) break;
      consumed += need;
    }
    if (consumed === 0) return true;
    const ready = this.#raw.slice(0, consumed);
    this.#raw = this.#raw.slice(consumed);

    const r = unpack(feedRaw(this.#state, ready));
    this.#state = r.state;
    if (r.toSend.length > 0) await this.#conn.write(r.toSend);
    if (r.appData.length > 0) {
      const grown = new Uint8Array(this.#plain.length + r.appData.length);
      grown.set(this.#plain);
      grown.set(r.appData, this.#plain.length);
      this.#plain = grown;
    }
    return true;
  }

  /** Whatever application data has arrived, waiting for at least one byte. Null at EOF. */
  async read(): Promise<Uint8Array | null> {
    while (this.#plain.length === 0) {
      if (this.#closed) return null;
      if (!await this.#pump()) return null;
      if (this.failure !== 0) throw new Error(`connection failed, code ${this.failure}`);
    }
    const out = this.#plain;
    this.#plain = new Uint8Array(0);
    return out;
  }

  async write(data: Uint8Array): Promise<void> {
    const r = unpack(sendRaw(this.#state, data));
    this.#state = r.state;
    await this.#conn.write(r.toSend);
  }

  /** Send close_notify, then drop the socket. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      const r = unpack(closeRaw(this.#state));
      this.#state = r.state;
      await this.#conn.write(r.toSend);
    } catch { /* the peer may have gone first, which is not our problem here */ }
    try { this.#conn.close(); } catch { /* already closed */ }
  }
}

/** A trust store with nothing in it: connect without validating a certificate path. */
export function noTrustStore(): { der: Uint8Array; offsets: Int32Array } {
  return { der: new Uint8Array(0), offsets: new Int32Array(0) };
}

if (import.meta.main) {
  const [host, portStr, caPath] = Deno.args;
  // A PEM bundle of any size, so this takes either a single test CA or the system store.
  const store = pemBundle(await Deno.readTextFile(caPath ?? "/etc/ssl/certs/ca-certificates.crt"));
  const target = Deno.env.get("TLS_CONNECT_HOST") ?? "127.0.0.1";
  const r = await request(target, Number(portStr), host, store,
    `GET / HTTP/1.1\r\nHost: ${host}\r\nconnection: close\r\n\r\n`);
  if (r.failure !== 0) console.log(`handshake failed, code ${r.failure}`);
  else console.log(r.response);
}
