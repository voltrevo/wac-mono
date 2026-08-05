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

// **A clock may hurry, but it may not decide.** This used to conclude "the parser wants more bytes" by
// waiting 60 ms and seeing whether llhttp had said anything, which makes the oracle's answer a function
// of how busy the machine is: under load a *complete* request misses the window, is reported as
// incomplete, and the differential fails with "llhttp wanted more bytes, wac accepted" against a change
// that touched neither. Four of the five flakes in wac-mono 0082 are that.
//
// The window stays, because it is what keeps this fast — but it no longer produces a verdict. When it
// fires, the connection is **half-closed** and llhttp is asked directly: a complete message reaches the
// request handler, a malformed one reaches `clientError`, and one that genuinely needed more bytes
// reaches `clientError` with an EOF-state code or aborts a request whose headers had already parsed. The
// answer comes from the parser and the end of the input, so a slow machine costs milliseconds rather
// than a wrong outcome.
//
// Asking *only* at EOF, with no window at all, was the first attempt: correct and forty seconds for
// `http.test.ts` against three, because some shapes leave node's server holding a half-closed socket
// until one of its own timeouts. The window is what avoids that.
// Overridable so a test can set it to zero and prove the point: with no window at all, every case takes
// the EOF path and the outcomes must be identical. `oracle_clock.test.ts` asserts exactly that, which is
// the regression test for 0082 — a machine so slow that the window never helps is the same machine as one
// where the window has been switched off.
const NUDGE_MS = Number(process.env.WAC_HTTP_ORACLE_NUDGE_MS ?? "60");

// A backstop against a hang, not a decision procedure, and deliberately loud: it records `timeout`,
// which the TypeScript side throws on. A safety net that silently answers "incomplete" is how the
// original became a decision.
const HANG_BACKSTOP_MS = 10_000;

/** llhttp's code for "the input ended in the middle of a message" — the deterministic "incomplete". */
const EOF_CODES = new Set(["HPE_INVALID_EOF_STATE", "HPE_CB_MESSAGE_COMPLETE", "ECONNRESET"]);

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
  // Headers parsed, body cut short by the half-close: incomplete, not an error and not ok.
  req.on("aborted", () => record(req.socket.remotePort, { outcome: "incomplete" }));
});

// A malformed message never reaches the request handler; it arrives here instead.
server.on("clientError", (err, socket) => {
  const code = err.code ?? String(err.message);
  // An EOF-state error is not a refusal: it is llhttp saying the message was still open when the input
  // ended, which is precisely the third outcome. Distinguishing them here is what removes the clock.
  record(socket.remotePort, EOF_CODES.has(code) ? { outcome: "incomplete" } : { outcome: "error", code });
  socket.destroy();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

/**
 * One case: connect, write it, and wait for llhttp to decide or for the window to close.
 *
 * Unchanged in what it does. It used to be the body of a sequential loop, and the loop was the whole
 * cost: **an incomplete message is only ever resolved by the timeout**, because llhttp neither
 * accepts nor rejects it — so a test made entirely of incomplete cases paid `CASE_TIMEOUT_MS` once
 * per case, in series. `http.test.ts`'s two prefix tests are exactly that shape and were 3s and 4s
 * between them; the package was 13s and is 3s.
 */
function runCase(i) {
  const bytes = Buffer.from(cases[i], "base64");
  return new Promise((resolve) => {
    // **Started after the write, not before it.** With the window at zero — which is how a test emulates
    // a machine too slow for any window to help — a timer created here would race the connect callback
    // and could half-close before the bytes went out. That is not slowness, it is an empty request, and
    // the first version of `oracle_clock.test.ts` caught it by reporting a complete `GET` as incomplete.
    let nudge;
    const socket = net.connect(port, "127.0.0.1", () => {
      byPort.set(socket.localPort, i);
      socket.write(bytes);
      nudge = setTimeout(() => {
        if (results[i] !== null) return finish();
        socket.end();
      }, NUDGE_MS);
    });
    const finish = () => {
      clearTimeout(nudge);
      clearTimeout(backstop);
      socket.destroy();
      resolve();
    };
    const backstop = setTimeout(() => {
      if (results[i] === null) results[i] = { outcome: "timeout" };
      finish();
    }, HANG_BACKSTOP_MS);
    // A verdict can arrive as a response written back, as the server closing after `clientError`, or as
    // the socket ending once the half-close is reciprocated. Whichever comes first, the recorded value
    // is llhttp's.
    socket.on("data", () => { if (results[i] !== null) finish(); });
    socket.on("close", () => {
      clearTimeout(nudge);
      clearTimeout(backstop);
      // Nothing recorded and the connection is over: llhttp said nothing about a message it never
      // completed, which is the third outcome.
      if (results[i] === null) results[i] = { outcome: "incomplete" };
      resolve();
    });
    socket.on("error", () => {
      clearTimeout(nudge);
      clearTimeout(backstop);
      if (results[i] === null) results[i] = { outcome: "incomplete" };
      resolve();
    });
  });
}

/**
 * Cases in flight at once.
 *
 * Safe because a result is correlated by the *client's port* rather than by a running index — see
 * `byPort` above, which exists because llhttp's `clientError` for one case can arrive after the next
 * connection has opened. That already had to hold when the cases were sequential; it is what makes
 * them independent now, and `oracle_batch.test.ts` asserts it by mixing all three outcomes in one
 * batch. Reintroducing the index breaks that test immediately.
 *
 * Bounded rather than unlimited: a few hundred simultaneous connects risks the listen backlog and the
 * descriptor limit, and neither failure would look like a parser disagreement. It mattered more when a
 * 60 ms window per case dominated the run — thirty-two turned 110 sequential windows into four — and it
 * is kept because the backlog argument stands on its own.
 */
const CONCURRENCY = 32;

for (let start = 0; start < cases.length; start += CONCURRENCY) {
  const batch = [];
  for (let i = start; i < Math.min(start + CONCURRENCY, cases.length); i++) batch.push(runCase(i));
  await Promise.all(batch);
}

server.close();
process.stdout.write(JSON.stringify(results));
