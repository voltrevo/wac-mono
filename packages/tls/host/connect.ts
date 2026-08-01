// A TLS 1.3 client. The socket and the randomness live here; everything else is wac.
//
//   deno run -A packages/tls/host/connect.ts <host> <port> <ca.pem>

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/tls/test/wac/probe.wac");
const init = mod.cliInit as (
  h: Uint8Array, root: Uint8Array, e: Uint8Array, p256: Uint8Array, kemSeed: Uint8Array,
  r: Uint8Array, now: bigint,
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

export { failure, feedRaw as feed, init, phase, closeRaw as close, sendRaw as send };

/**
 * Connect, handshake, send `request`, and return the first response.
 *
 * Records are handed to wac whole, the same discipline both servers use.
 */
export async function request(
  hostname: string, port: number, serverName: string, rootDer: Uint8Array, req: string,
): Promise<{ response: string; failure: number }> {
  const conn = await Deno.connect({ hostname, port });
  const enc = new TextEncoder();
  let state: Uint8Array;
  {
    const r = unpack(init(
      enc.encode(serverName), rootDer,
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
  const root = pemToDer(await Deno.readTextFile(caPath));
  const r = await request("127.0.0.1", Number(portStr), host, root,
    `GET / HTTP/1.1\r\nHost: ${host}\r\nconnection: close\r\n\r\n`);
  if (r.failure !== 0) console.log(`handshake failed, code ${r.failure}`);
  else console.log(r.response);
}
