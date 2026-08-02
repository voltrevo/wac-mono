// The client's socket half, which is all the host does.
//
// Symmetric with `packages/server/host/serve.ts`: wac builds the request bytes and decides when a
// response is complete, and this connects, writes, and reads until wac says stop. The `eof` flag
// is the one thing the host knows and wac cannot — whether the connection has closed — and it is
// passed in rather than guessed, because a close-delimited response is complete exactly when it
// arrives.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/http/test/client_probe.wac") as unknown as {
  buildRequest(
    method: Uint8Array, target: Uint8Array, host: Uint8Array, headers: Uint8Array,
    body: Uint8Array, keepAlive: boolean,
  ): Uint8Array;
  parse(input: Uint8Array, method: Uint8Array, eof: boolean, maxBody: number): Uint8Array;
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX_BODY = 1 << 20;

export type Response = {
  status: number;
  minor: number;
  headers: Array<[string, string]>;
  body: string;
  closeDelimited: boolean;
  consumed: number;
};

export type Result =
  | { ok: true; response: Response }
  | { ok: false; reason: "rejected"; code: number }
  | { ok: false; reason: "truncated" };

export type Options = {
  method?: string;
  headers?: Array<[string, string]>;
  body?: string;
  keepAlive?: boolean;
};

/** The request bytes wac would send. Exposed so a test can put them on any socket it likes. */
export function buildRequest(host: string, target: string, options: Options = {}): Uint8Array {
  const headerBytes = (options.headers ?? []).flatMap(([n, v]) => [n, v]).join("\0");
  return mod.buildRequest(
    enc.encode(options.method ?? "GET"),
    enc.encode(target),
    enc.encode(host),
    enc.encode(headerBytes),
    enc.encode(options.body ?? ""),
    options.keepAlive ?? false,
  );
}

/** Parse whatever has arrived so far. `eof` says no more is coming. */
export function parseResponse(bytes: Uint8Array, method: string, eof: boolean): Result | null {
  const parts = dec.decode(mod.parse(bytes, enc.encode(method), eof, MAX_BODY)).split("\0");
  if (parts[0] === "incomplete") return null;
  if (parts[0] === "bad") return { ok: false, reason: "rejected", code: Number(parts[1]) };
  const headers: Array<[string, string]> = [];
  for (let i = 6; i + 1 < parts.length; i += 2) headers.push([parts[i], parts[i + 1]]);
  return {
    ok: true,
    response: {
      status: Number(parts[1]),
      minor: Number(parts[2]),
      consumed: Number(parts[3]),
      closeDelimited: parts[4] === "1",
      body: parts[5],
      headers,
    },
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** One request over a fresh connection. */
/** The part of `Deno.Conn` this needs — see `Socket` in the tls package for why this shape. */
type Socket = {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
};

/**
 * Do a request over a connection the caller already has.
 *
 * Split out from `request` so that anything socket-shaped works: a TLS stream, a stream
 * inside a Tor circuit, a pipe in a test. The loop was already correct and general; it was
 * only the `Deno.connect` at the top that made it TCP-specific.
 *
 * `authority` is what goes in the Host header, which is not always where the bytes are
 * going — through a proxy or a Tor exit those differ, and the header must name the origin
 * the request is *for*.
 */
export async function requestOver(
  conn: Socket,
  authority: string,
  target: string,
  options: Options = {},
): Promise<Result> {
  const method = options.method ?? "GET";
  try {
    const out = buildRequest(authority, target, options);
    let at = 0;
    while (at < out.length) at += await conn.write(out.subarray(at));

    let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    while (true) {
      const chunk = new Uint8Array(16384);
      const n = await conn.read(chunk);
      const eof = n === null;
      if (!eof) buffer = concat(buffer, chunk.subarray(0, n));
      const result = parseResponse(buffer, method, eof);
      if (result !== null) return result;
      // The connection closed and wac still wants more: the response was cut off.
      if (eof) return { ok: false, reason: "truncated" };
    }
  } finally {
    try {
      conn.close();
    } catch { /* already closed */ }
  }
}

export async function request(
  hostname: string,
  port: number,
  target: string,
  options: Options = {},
): Promise<Result> {
  const method = options.method ?? "GET";
  const conn = await Deno.connect({ hostname, port });
  try {
    const out = buildRequest(`${hostname}:${port}`, target, options);
    let at = 0;
    while (at < out.length) at += await conn.write(out.subarray(at));

    let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    while (true) {
      const chunk = new Uint8Array(16384);
      const n = await conn.read(chunk);
      const eof = n === null;
      if (!eof) buffer = concat(buffer, chunk.subarray(0, n));
      const result = parseResponse(buffer, method, eof);
      if (result !== null) return result;
      // The connection closed and wac still wants more: the response was cut off.
      if (eof) return { ok: false, reason: "truncated" };
    }
  } finally {
    try {
      conn.close();
    } catch { /* already closed */ }
  }
}
