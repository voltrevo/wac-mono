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
