// The server behind a real socket, driven by real clients.
//
// `serve.test.ts` proves the function is right. This proves the answers survive contact with
// software that was not written to agree with them — three independent clients, each with its own
// opinions about what a response should look like:
//
//   fetch   Deno's, which is strict and will reject a malformed response outright
//   node    a second implementation, so a response both accept is not merely self-consistent
//   socket  raw bytes, for the things no client will do on purpose — pipelining two requests in
//           one packet, splitting a request across packets, sending a smuggling-shaped message
//
// The socket cases are the reason this file exists. Keep-alive and pipelining are properties of a
// *connection*, and a function from bytes to bytes cannot demonstrate them however carefully it is
// tested.

import { listen } from "../host/serve.ts";

const dec = new TextDecoder();
const enc = new TextEncoder();

const listener = await listen(0);
const port = (listener.addr as Deno.NetAddr).port;
const base = `http://127.0.0.1:${port}`;

// Deno's test runner complains about a listener left open, and closing it in each test would
// race the others.
addEventListener("unload", () => {
  try {
    listener.close();
  } catch { /* already closed */ }
});

/** Write `request` on a fresh connection and read until the server closes or goes quiet. */
async function raw(request: string, waitMs = 250): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  await conn.write(enc.encode(request));
  let out = "";
  const deadline = Date.now() + waitMs;
  try {
    while (Date.now() < deadline) {
      const buf = new Uint8Array(4096);
      const n = await Promise.race([
        conn.read(buf),
        new Promise<null>(r => setTimeout(() => r(null), deadline - Date.now())),
      ]);
      if (n === null || n === 0) break;
      out += dec.decode(buf.subarray(0, n));
    }
  } catch { /* the server closed, which is an answer */ }
  try {
    conn.close();
  } catch { /* already closed */ }
  return out;
}

Deno.test("fetch is satisfied by every route", async () => {
  const cases: Array<[string, number, string]> = [
    ["/", 200, "wac http server\n"],
    ["/echo?a=1&b=hello+world", 200, '{"a":"1","b":"hello world"}'],
    ["/b64/aGVsbG8gd29ybGQ", 200, "hello world"],
    ["/match/(%5Cw%2B)%40(%5Cw%2B)/mail%20a%40b", 200, '{"matched":true,"groups":["a@b","a","b"],"start":5}'],
    ["/nope", 404, "no route\n"],
  ];
  for (const [path, status, body] of cases) {
    const res = await fetch(base + path);
    const text = await res.text();
    if (res.status !== status) throw new Error(`${path}: status ${res.status}, want ${status}`);
    if (text !== body) throw new Error(`${path}: body ${JSON.stringify(text)}`);
  }

  // A POST with a body, which is the path that exercises Content-Length in both directions.
  const posted = await fetch(base + "/json", { method: "POST", body: '{"b":1,"a":[1,2]}' });
  if (await posted.text() !== '{"b":1,"a":[1,2]}') throw new Error("the json route lost something");

  // And that the reported time is a time, parsed back by the platform rather than by us.
  const time = await (await fetch(base + "/time")).json() as { now: string };
  if (Number.isNaN(Date.parse(time.now))) throw new Error(`/time returned ${time.now}`);
  if (Math.abs(Date.parse(time.now) - Date.now()) > 60000) {
    throw new Error(`/time is an hour out: ${time.now}`);
  }
});

Deno.test("Node's http client is satisfied too", async () => {
  // A second, independent client. A response that only Deno accepts might be one Deno is being
  // generous about; one that two implementations accept is a response.
  const script = `
    const http = require("node:http");
    const paths = ["/", "/time", "/echo?a=1", "/nope"];
    const out = [];
    (async () => {
      for (const path of paths) {
        await new Promise((resolve, reject) => {
          const req = http.request({ host: "127.0.0.1", port: ${port}, path, method: "GET" }, (res) => {
            let body = "";
            res.on("data", (c) => body += c);
            res.on("end", () => {
              out.push({ path, status: res.statusCode, len: body.length,
                         type: res.headers["content-type"] ?? null });
              resolve();
            });
          });
          req.on("error", reject);
          req.end();
        });
      }
      process.stdout.write(JSON.stringify(out));
    })().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
  `;
  const command = new Deno.Command("node", { args: ["-e", script], stdout: "piped", stderr: "piped" });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) throw new Error(`node client failed: ${dec.decode(stderr)}`);
  const results = JSON.parse(dec.decode(stdout)) as Array<{ path: string; status: number; len: number; type: string | null }>;
  const byPath = new Map(results.map(r => [r.path, r]));
  if (byPath.get("/")?.status !== 200) throw new Error("node: / did not return 200");
  if (byPath.get("/nope")?.status !== 404) throw new Error("node: /nope did not return 404");
  if (byPath.get("/time")?.type !== "application/json") throw new Error("node: /time content type");
  if ((byPath.get("/")?.len ?? 0) === 0) throw new Error("node: / had no body");
});

Deno.test("keep-alive: two requests, one connection", async () => {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const read = async (): Promise<string> => {
    const buf = new Uint8Array(4096);
    const n = await conn.read(buf);
    return n === null ? "" : dec.decode(buf.subarray(0, n));
  };
  await conn.write(enc.encode("GET / HTTP/1.1\r\nHost: a\r\n\r\n"));
  const first = await read();
  if (!first.startsWith("HTTP/1.1 200")) throw new Error(`first response: ${first.slice(0, 40)}`);

  // The same connection, a second request. If `consumed` were wrong this would hang or answer
  // nonsense, and no amount of testing the function in isolation would have shown it.
  await conn.write(enc.encode("GET /nope HTTP/1.1\r\nHost: a\r\n\r\n"));
  const second = await read();
  if (!second.startsWith("HTTP/1.1 404")) throw new Error(`second response: ${second.slice(0, 40)}`);
  conn.close();
});

Deno.test("pipelining: two requests in one packet", async () => {
  // Both requests written before either is answered. A server that waits for more input after
  // the first would deadlock here, which is why the accept loop drains the buffer before reading.
  const out = await raw("GET / HTTP/1.1\r\nHost: a\r\n\r\nGET /nope HTTP/1.1\r\nHost: a\r\n\r\n");
  const statuses = [...out.matchAll(/HTTP\/1\.1 (\d+)/g)].map(m => m[1]);
  if (statuses.length !== 2) throw new Error(`got ${statuses.length} responses: ${JSON.stringify(out)}`);
  if (statuses[0] !== "200" || statuses[1] !== "404") {
    throw new Error(`pipelined statuses ${statuses.join(",")}`);
  }
});

Deno.test("a request split across packets is answered once it is whole", async () => {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const full = "POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 7\r\n\r\n{\"a\":1}";
  // One byte at a time, which is the shape that catches a server treating "not yet" as "no".
  for (const ch of full) {
    await conn.write(enc.encode(ch));
    await new Promise(r => setTimeout(r, 1));
  }
  const buf = new Uint8Array(4096);
  const n = await conn.read(buf);
  const out = n === null ? "" : dec.decode(buf.subarray(0, n));
  conn.close();
  if (!out.startsWith("HTTP/1.1 200")) throw new Error(`byte-at-a-time request: ${out.slice(0, 60)}`);
  if (!out.endsWith('{"a":1}')) throw new Error(`byte-at-a-time body: ${JSON.stringify(out)}`);
});

Deno.test("HTTP/1.0 gets one response and a closed connection", async () => {
  const out = await raw("GET / HTTP/1.0\r\n\r\n");
  if (!out.startsWith("HTTP/1.1 200")) throw new Error(`1.0 response: ${out.slice(0, 40)}`);
  if (!out.includes("Connection: close")) throw new Error("1.0 was not told the connection closes");

  const kept = await raw("GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n");
  if (!kept.includes("Connection: keep-alive")) throw new Error("1.0 keep-alive was refused");
});

Deno.test("a smuggling-shaped request gets 400 and the connection closes", async () => {
  // The end-to-end version of the framing tests: the second request must not be answered, because
  // a stream whose framing is in doubt is not a sequence of messages any more.
  const smuggle = "POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n"
    + "Transfer-Encoding: chunked\r\n\r\n0\r\n\r\nGET /nope HTTP/1.1\r\nHost: a\r\n\r\n";
  const out = await raw(smuggle);
  const statuses = [...out.matchAll(/HTTP\/1\.1 (\d+)/g)].map(m => m[1]);
  if (statuses.length !== 1) throw new Error(`answered ${statuses.length} messages: ${JSON.stringify(out)}`);
  if (statuses[0] !== "400") throw new Error(`status ${statuses[0]}, want 400`);
  if (!out.includes("Connection: close")) throw new Error("did not say the connection closes");
});

Deno.test("a client that disappears mid-request does not take the server with it", async () => {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  await conn.write(enc.encode("POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 100\r\n\r\n{"));
  conn.close();
  // The next request proves the server is still there.
  const res = await fetch(base + "/");
  if (res.status !== 200) throw new Error(`the server did not survive: ${res.status}`);
  await res.text();
});
