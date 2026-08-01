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
// Limits live here rather than in wac, because they are about time and connections and wac can
// see neither. All three are the ones a server actually needs, and a server without them is not
// finished — a client that opens a connection and says nothing would otherwise hold it forever.
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

export type Limits = {
  /** How long a client may take to finish sending one request, once it has started. */
  requestMs: number;
  /** How long a kept-alive connection may sit silent between requests. */
  idleMs: number;
  /** Connections served at once. Beyond this, new ones are closed immediately. */
  maxConnections: number;
};

export const DEFAULT_LIMITS: Limits = {
  requestMs: 10_000,
  idleMs: 30_000,
  maxConnections: 256,
};

let openConnections = 0;

/** A read that gives up after `ms`, so a silent client cannot hold a connection open. */
async function readWithTimeout(
  conn: Deno.Conn,
  buf: Uint8Array,
  ms: number,
): Promise<number | null | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">(resolve => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([conn.read(buf), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Serve one connection until it is closed or the client stops talking. */
export async function serveConnection(conn: Deno.Conn, limits: Limits = DEFAULT_LIMITS): Promise<void> {
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

      // A partly-sent request gets the request budget; an idle kept-alive connection gets the
      // idle one. They are different numbers because they are different situations: a slow
      // upload is not the same as a client that has gone away.
      const budget = buffer.length > 0 ? limits.requestMs : limits.idleMs;
      const chunk = new Uint8Array(16384);
      const n = await readWithTimeout(conn, chunk, budget);
      if (n === "timeout") {
        // A request that was underway gets told why; an idle connection is simply dropped, since
        // there is no request to answer.
        if (buffer.length > 0) {
          await writeAll(conn, new TextEncoder().encode(
            "HTTP/1.1 408 Request Timeout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
          )).catch(() => {});
        }
        return;
      }
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

export async function listen(port: number, limits: Limits = DEFAULT_LIMITS): Promise<Deno.Listener> {
  const listener = Deno.listen({ port, hostname: "127.0.0.1" });
  (async () => {
    for await (const conn of listener) {
      if (openConnections >= limits.maxConnections) {
        // Refusing immediately is kinder than accepting and being slow: the client finds out now.
        try {
          conn.close();
        } catch { /* already gone */ }
        continue;
      }
      openConnections++;
      serveConnection(conn, limits).finally(() => {
        openConnections--;
      });
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
