// A TLS 1.3 server you can point openssl at.
//
// The socket and the randomness live here because wasm has neither. Everything else —
// what a record means, what to answer, when the handshake is done — is decided in wac by
// `tlsServerFeed`, which is a pure function from (state, bytes) to (state, bytes).
//
//   deno run -A packages/tls/host/serve.ts [port]
//   openssl s_client -connect 127.0.0.1:8443 -tls1_3 -servername wac.test

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/tls/test/wac/probe.wac");
const init = mod.srvInit as (c: Uint8Array, s: Uint8Array, e: Uint8Array, r: Uint8Array) => Uint8Array;
const feed = mod.srvFeed as (state: Uint8Array, input: Uint8Array) => Uint8Array;
const send = mod.srvSend as (state: Uint8Array, data: Uint8Array) => Uint8Array;
const phase = mod.srvPhase as (state: Uint8Array) => number;
const recordNeeded = mod.srvRecordNeeded as (buf: Uint8Array) => number;

const cert = await Deno.readFile(new URL("../test/data/server.der", import.meta.url));
const seed = await Deno.readFile(new URL("../test/data/server.seed", import.meta.url));

/** Split the `[len][bytes]` triples that feed and send return. */
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

export function newConnection(): Uint8Array {
  return init(cert, seed,
    crypto.getRandomValues(new Uint8Array(32)),
    crypto.getRandomValues(new Uint8Array(32)));
}

export { feed, phase, recordNeeded, send };

if (import.meta.main) {
  const port = Number(Deno.args[0] ?? 8443);
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  console.log(`tls: listening on 127.0.0.1:${port}`);

  for await (const conn of listener) {
    (async () => {
      let state = newConnection();
      let buf = new Uint8Array(0);
      const chunk = new Uint8Array(16640);
      try {
        while (true) {
          const n = await conn.read(chunk);
          if (n === null) break;
          const merged = new Uint8Array(buf.length + n);
          merged.set(buf);
          merged.set(chunk.subarray(0, n), buf.length);
          buf = merged;

          // Hand over whole records only — the same buffering discipline the HTTP
          // server uses, and for the same reason: a partial record means nothing.
          let consumed = 0;
          while (buf.length - consumed >= 5 && recordNeeded(buf.subarray(consumed)) === 0) {
            consumed += 5 + ((buf[consumed + 3] << 8) | buf[consumed + 4]);
          }
          if (consumed === 0) continue;
          const ready = buf.slice(0, consumed);
          buf = buf.slice(consumed);

          const r = unpack(feed(state, ready));
          state = r.state;
          if (r.toSend.length > 0) await conn.write(r.toSend);
          if (r.appData.length > 0) {
            const text = new TextDecoder().decode(r.appData);
            const body = `hello from wac over TLS 1.3\nyou said: ${JSON.stringify(text.split("\r\n")[0])}\n`;
            const http = `HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n` +
              `content-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`;
            const s = unpack(send(state, new TextEncoder().encode(http)));
            state = s.state;
            await conn.write(s.toSend);
            break;
          }
        }
      } catch (e) {
        console.log("connection error:", String(e).split("\n")[0]);
      }
      try { conn.close(); } catch { /* already closed */ }
    })();
  }
}
