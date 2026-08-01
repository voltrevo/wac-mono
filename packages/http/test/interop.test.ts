// The 2×2: two clients, two servers, and the diagonal is what matters.
//
//                       wac server            Node server
//   wac client          the loop closes       tests the client's parser
//   fetch / Node        tests the writer      the control
//
// A round trip through my own writer and my own parser proves nothing: two halves wrong in
// opposite ways agree perfectly. The diagonal is the evidence. A wac client reading a Node
// server's responses tests the response parser against output nobody wrote to please it; `fetch`
// reading the wac server's responses tests the writer the same way. Passing both means each half
// is right on its own, which is exactly what the round trip cannot show.
//
// This is the same argument as `packages/datetime`, where `Date.UTC` checks the day arithmetic
// directly rather than by round-tripping it against itself.

import { listen } from "../../server/host/serve.ts";
import { request } from "../host/client.ts";

const dec = new TextDecoder();

// The wac server.
const wacServer = await listen(0);
const wacPort = (wacServer.addr as Deno.NetAddr).port;

// A Node server, started as a subprocess and told to answer a fixed set of routes. Deliberately
// not Deno's `serve`: a second *implementation*, not a second instance.
const nodeScript = `
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    if (req.url === "/plain") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "5" });
      res.end("hello");
    } else if (req.url === "/chunked") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("chun");
      res.write("ked");
      res.end();
    } else if (req.url === "/empty") {
      res.writeHead(204);
      res.end();
    } else if (req.url === "/close") {
      // No Content-Length and no chunking: the body is whatever arrives before the close. Written
      // straight onto the socket, because Node's own API will not produce this: writeHead does
      // not flush until write or end, and either of those adds a framing header.
      res.socket.write(
        "HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\nuntil close",
      );
      res.socket.end();
    } else if (req.url === "/headers") {
      res.writeHead(200, { "X-One": "1", "X-Two": "2", "Content-Length": "0" });
      res.end();
    } else if (req.url === "/echo-method") {
      res.writeHead(200, { "Content-Length": String(req.method.length) });
      res.end(req.method === "HEAD" ? undefined : req.method);
    } else {
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
    }
  });
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n");
  });
`;
const nodeProc = new Deno.Command("node", {
  args: ["-e", nodeScript],
  stdout: "piped",
  stderr: "piped",
}).spawn();
const nodeReader = nodeProc.stdout.getReader();
const nodePort = await (async (): Promise<number> => {
  let acc = "";
  while (!acc.includes("\n")) {
    const { value, done } = await nodeReader.read();
    if (done) {
      const err = await new Response(nodeProc.stderr).text();
      throw new Error(`the node server did not start: ${err}`);
    }
    acc += dec.decode(value);
  }
  return (JSON.parse(acc.trim()) as { port: number }).port;
})();

addEventListener("unload", () => {
  try {
    wacServer.close();
  } catch { /* already closed */ }
  try {
    nodeReader.cancel();
    nodeProc.kill();
  } catch { /* already gone */ }
});

Deno.test("wac client → Node server: the response parser against a real server", async () => {
  // The diagonal that tests the parser. None of these responses was written to please it.
  const plain = await request("127.0.0.1", nodePort, "/plain");
  if (!plain.ok) throw new Error(`/plain: ${JSON.stringify(plain)}`);
  if (plain.response.status !== 200) throw new Error(`/plain status ${plain.response.status}`);
  if (plain.response.body !== "hello") throw new Error(`/plain body ${JSON.stringify(plain.response.body)}`);

  // Node chose chunked here, because it did not know the length in advance. That is the coding
  // path, exercised by a server that picked it rather than by a test that asked for it.
  const chunked = await request("127.0.0.1", nodePort, "/chunked");
  if (!chunked.ok) throw new Error(`/chunked: ${JSON.stringify(chunked)}`);
  if (chunked.response.body !== "chunked") throw new Error(`/chunked body ${JSON.stringify(chunked.response.body)}`);
  const te = chunked.response.headers.find(([n]) => n.toLowerCase() === "transfer-encoding");
  if (te === undefined) throw new Error("/chunked was not actually chunked, so this proves nothing");

  const empty = await request("127.0.0.1", nodePort, "/empty");
  if (!empty.ok || empty.response.status !== 204) throw new Error(`/empty: ${JSON.stringify(empty)}`);
  if (empty.response.body !== "") throw new Error("/empty had a body");

  // Rule 5, from a server that really does close the connection to end the message.
  const closed = await request("127.0.0.1", nodePort, "/close");
  if (!closed.ok) throw new Error(`/close: ${JSON.stringify(closed)}`);
  if (closed.response.body !== "until close") throw new Error(`/close body ${JSON.stringify(closed.response.body)}`);
  if (!closed.response.closeDelimited) throw new Error("/close was not reported as close-delimited");

  const headers = await request("127.0.0.1", nodePort, "/headers");
  if (!headers.ok) throw new Error(`/headers: ${JSON.stringify(headers)}`);
  const names = headers.response.headers.map(([n]) => n.toLowerCase());
  if (!names.includes("x-one") || !names.includes("x-two")) {
    throw new Error(`/headers lost fields: ${JSON.stringify(headers.response.headers)}`);
  }

  const missing = await request("127.0.0.1", nodePort, "/nope");
  if (!missing.ok || missing.response.status !== 404) throw new Error("/nope was not a 404");
});

Deno.test("wac client → Node server: HEAD has no body however long the header says", async () => {
  // The trap this parser exists to avoid. Node answers HEAD with `Content-Length: 4` and no
  // bytes; a client that waits for four is stuck, and one that reads four takes them from the
  // next response.
  const head = await request("127.0.0.1", nodePort, "/echo-method", { method: "HEAD" });
  if (!head.ok) throw new Error(`HEAD: ${JSON.stringify(head)}`);
  if (head.response.body !== "") throw new Error(`HEAD returned a body: ${JSON.stringify(head.response.body)}`);
  const cl = head.response.headers.find(([n]) => n.toLowerCase() === "content-length");
  if (cl === undefined || cl[1] === "0") {
    throw new Error("the server did not send a non-zero Content-Length, so this proves nothing");
  }

  const get = await request("127.0.0.1", nodePort, "/echo-method", { method: "GET" });
  if (!get.ok || get.response.body !== "GET") throw new Error(`GET: ${JSON.stringify(get)}`);
});

Deno.test("wac client → wac server: the loop closes", async () => {
  // Both ends mine, so this proves less on its own — but it is the whole stack in one call, and
  // it is what "a server and a client written in wac" actually means.
  const root = await request("127.0.0.1", wacPort, "/");
  if (!root.ok) throw new Error(`/: ${JSON.stringify(root)}`);
  if (root.response.body !== "wac http server\n") throw new Error(`/ body ${JSON.stringify(root.response.body)}`);

  const echo = await request("127.0.0.1", wacPort, "/echo?a=1&b=two");
  if (!echo.ok || echo.response.body !== '{"a":"1","b":"two"}') {
    throw new Error(`/echo: ${JSON.stringify(echo)}`);
  }

  const posted = await request("127.0.0.1", wacPort, "/json", {
    method: "POST",
    body: '{"z":[1,2],"a":null}',
  });
  if (!posted.ok || posted.response.body !== '{"z":[1,2],"a":null}') {
    throw new Error(`/json: ${JSON.stringify(posted)}`);
  }

  const missing = await request("127.0.0.1", wacPort, "/nope");
  if (!missing.ok || missing.response.status !== 404) throw new Error("/nope was not a 404");
});

Deno.test("fetch → wac server: the response writer against a strict client", async () => {
  // The other diagonal. `fetch` rejects a malformed response outright rather than coping.
  const res = await fetch(`http://127.0.0.1:${wacPort}/time`);
  const body = await res.json() as { now: string };
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  if (Number.isNaN(Date.parse(body.now))) throw new Error(`/time gave ${body.now}`);
});

Deno.test("the same request bytes are accepted by both servers", async () => {
  // The writer, checked by sending its output to two independent servers. A request only one
  // accepts is a request with something wrong in it.
  for (
    const [target, options] of [
      ["/", {}],
      ["/plain", {}],
      ["/nope", { method: "GET" as const }],
    ] as Array<[string, { method?: string }]>
  ) {
    const fromWac = await request("127.0.0.1", wacPort, target, options);
    const fromNode = await request("127.0.0.1", nodePort, target, options);
    if (!fromWac.ok) throw new Error(`the wac server refused ${target}: ${JSON.stringify(fromWac)}`);
    if (!fromNode.ok) throw new Error(`the node server refused ${target}: ${JSON.stringify(fromNode)}`);
    // Both answered something; the statuses differ because the routes differ, and that is fine.
    if (fromWac.response.status === 0 || fromNode.response.status === 0) {
      throw new Error(`${target}: a server did not produce a status`);
    }
  }
});
