// The oracle: what llhttp makes of a byte string, reported over stdin/stdout.
//
// Node parses HTTP with llhttp, which is the most exercised HTTP/1.1 parser there is. Rather
// than reimplement a reference, this drives the real one: start a server on loopback, open a
// connection per case, write the bytes, and report what the parser produced or the error it
// raised.
//
// Reads a JSON array of base64 byte strings on stdin and writes a JSON array of results.
//
// Three outcomes, and they are deliberately distinct — a parser that treats "not yet" as
// "rejected" is exactly the bug this is here to catch:
//
//   ok         a complete message, with everything it parsed
//   error      the parser refused it
//   incomplete the parser wants more bytes and has not decided

import http from "node:http";
import net from "node:net";

const CASE_TIMEOUT_MS = 60;

const raw = await new Promise((resolve) => {
  let acc = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => acc += d);
  process.stdin.on("end", () => resolve(acc));
});
const cases = JSON.parse(raw);

const results = new Array(cases.length).fill(null);
// Correlated by the client's port, not by a running index. A `clientError` for one case can
// arrive after the next connection has opened, and an index would record it against the wrong
// case — which showed up as valid requests being reported as errors.
const byPort = new Map();

function record(port, value) {
  const i = byPort.get(port);
  if (i !== undefined && results[i] === null) results[i] = value;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    record(req.socket.remotePort, {
      outcome: "ok",
      method: req.method,
      target: req.url,
      version: req.httpVersion,
      // rawHeaders keeps order and duplicates, which `headers` folds away — and the folding
      // is one of the things under test.
      rawHeaders: req.rawHeaders,
      body: Buffer.concat(chunks).toString("base64"),
      trailers: req.rawTrailers ?? [],
    });
    res.end();
  });
  req.on("aborted", () => {});
});

// A malformed message never reaches the request handler; it arrives here instead.
server.on("clientError", (err, socket) => {
  record(socket.remotePort, { outcome: "error", code: err.code ?? String(err.message) });
  socket.destroy();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

for (let i = 0; i < cases.length; i++) {
  const bytes = Buffer.from(cases[i], "base64");
  await new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      byPort.set(socket.localPort, i);
      socket.write(bytes);
    });
    const done = () => {
      socket.destroy();
      resolve();
    };
    // The parser has neither accepted nor rejected within the window, so it is waiting for
    // more input. That is a third answer, not a refusal.
    const timer = setTimeout(() => {
      if (results[i] === null) results[i] = { outcome: "incomplete" };
      done();
    }, CASE_TIMEOUT_MS);
    const finish = () => {
      if (results[i] !== null) {
        clearTimeout(timer);
        done();
      }
    };
    socket.on("data", finish);
    socket.on("close", () => {
      clearTimeout(timer);
      if (results[i] === null) results[i] = { outcome: "incomplete" };
      resolve();
    });
    socket.on("error", () => {
      clearTimeout(timer);
      if (results[i] === null) results[i] = { outcome: "error", code: "SOCKET" };
      resolve();
    });
  });
}

server.close();
process.stdout.write(JSON.stringify(results));
