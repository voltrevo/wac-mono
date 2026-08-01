// The accept loop, which is everything wac cannot do and nothing else.
//
// wasm has no sockets and no clock, so the host owns both and hands the results in. Every
// decision — is this a complete request, what does it mean, what should the answer be, does the
// connection stay open — is made in wac by `serve`, which is a pure function from bytes to bytes.
//
// The buffer discipline is the interesting part and it is small: accumulate what arrives, call
// `serve`, and if it answers, write the response and drop exactly `consumed` bytes. Keeping the
// remainder rather than clearing the buffer is what makes pipelining work — a client may have
// sent the next request already, and it is sitting in the tail.
//
//   deno run -A packages/server/host/serve.ts [port]

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/server/test/probe.wac") as unknown as {
  handle(input: Uint8Array, nowMillis: bigint): Uint8Array;
};

const dec = new TextDecoder();

export type Handled =
  | { ready: false }
  | { ready: true; consumed: number; keepAlive: boolean; response: Uint8Array };

/** Call into wac. Exported so the tests can drive the server without a socket. */
export function handle(input: Uint8Array, nowMillis: number): Handled {
  const out = mod.handle(input, BigInt(nowMillis));
  // `wait` is the whole answer when more bytes are needed.
  if (out.length === 4 && dec.decode(out) === "wait") return { ready: false };

  // ready\0consumed\0keepAlive\0<response>, with the response left binary.
  let at = 0;
  const field = (): string => {
    const start = at;
    while (at < out.length && out[at] !== 0) at++;
    const s = dec.decode(out.subarray(start, at));
    at++;
    return s;
  };
  field();                                   // "ready"
  const consumed = Number(field());
  const keepAlive = field() === "1";
  return { ready: true, consumed, keepAlive, response: out.subarray(at) };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Serve one connection until it is closed or the client stops talking. */
export async function serveConnection(conn: Deno.Conn): Promise<void> {
  let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  try {
    while (true) {
      // Answer everything already buffered before reading again: a pipelined client sends two
      // requests in one packet, and waiting for more input after the first would deadlock.
      let progressed = true;
      while (progressed) {
        progressed = false;
        const result = handle(buffer, Date.now());
        if (!result.ready) break;
        await writeAll(conn, result.response);
        buffer = buffer.subarray(result.consumed) as Uint8Array<ArrayBuffer>;
        progressed = result.consumed > 0 && buffer.length > 0;
        if (!result.keepAlive) return;
      }

      const chunk = new Uint8Array(16384);
      const n = await conn.read(chunk);
      if (n === null) return;
      buffer = concat(buffer, chunk.subarray(0, n));
    }
  } catch {
    // A client that disappears mid-request is ordinary, not an error worth reporting.
  } finally {
    try {
      conn.close();
    } catch { /* already closed */ }
  }
}

export async function listen(port: number): Promise<Deno.Listener> {
  const listener = Deno.listen({ port, hostname: "127.0.0.1" });
  (async () => {
    for await (const conn of listener) {
      serveConnection(conn);
    }
  })();
  return listener;
}

async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let at = 0;
  while (at < data.length) {
    at += await conn.write(data.subarray(at));
  }
}

if (import.meta.main) {
  const port = Number(Deno.args[0] ?? "8080");
  const listener = await listen(port);
  const address = listener.addr as Deno.NetAddr;
  console.log(`listening on http://127.0.0.1:${address.port}`);
}
