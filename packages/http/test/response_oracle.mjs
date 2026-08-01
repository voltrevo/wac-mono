// The response oracle: what llhttp makes of a response, via Node's HTTP *client*.
//
// The mirror of `oracle_node.mjs`. That one drove a server to parse requests; this drives a
// client to parse responses. A raw TCP server writes exactly the bytes under test, Node's
// `http.request` reads them, and whatever it produced — or the error it raised — comes back.
//
// The request method is part of each case, because response framing depends on it: a HEAD
// response has no body however long its Content-Length says it is, and getting that wrong is the
// client-side desync.
//
// Reads `[{ bytes: base64, method }]` on stdin, writes results on stdout.

import http from "node:http";
import net from "node:net";

const CASE_TIMEOUT_MS = 80;

const raw = await new Promise((resolve) => {
  let acc = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => acc += d);
  process.stdin.on("end", () => resolve(acc));
});
const cases = JSON.parse(raw);
const results = new Array(cases.length).fill(null);

for (let i = 0; i < cases.length; i++) {
  const bytes = Buffer.from(cases[i].bytes, "base64");
  const closeAfter = cases[i].closeAfter !== false;

  // A raw TCP server, not an http one: the point is to send bytes nobody would generate.
  const server = net.createServer((socket) => {
    socket.on("data", () => {});
    socket.write(bytes);
    if (closeAfter) setTimeout(() => socket.end(), 20);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      results[i] = value;
      resolve();
    };
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: cases[i].method },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          done({
            outcome: "ok",
            status: res.statusCode,
            version: res.httpVersion,
            rawHeaders: res.rawHeaders,
            body: Buffer.concat(chunks).toString("base64"),
          });
        });
        res.on("aborted", () => done({ outcome: "incomplete" }));
      },
    );
    req.on("error", (err) => done({ outcome: "error", code: err.code ?? String(err.message) }));
    setTimeout(() => done({ outcome: "incomplete" }), CASE_TIMEOUT_MS);
    req.end();
  });

  await new Promise((r) => server.close(r));
}

process.stdout.write(JSON.stringify(results));
