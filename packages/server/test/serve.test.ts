// The server as a pure function: bytes in, bytes out.
//
// No sockets here. `serve` is a function from a byte buffer to a response, how much of the buffer
// it used, and whether the connection stays open — so the whole of it can be tested by calling it,
// including the parts that are awkward over a real connection: what happens to a pipelined pair,
// what a truncated request does, what an HTTP/1.0 client gets.
//
// `test/live.test.ts` then runs the same server behind a socket and checks the answers survive
// contact with real clients. Both are needed. This one can reach states a client cannot easily
// produce; that one catches anything the harness is wrong about.

import { handle } from "../host/serve.ts";

const dec = new TextDecoder();
const enc = new TextEncoder();

const NOW = Date.UTC(2020, 5, 15, 10, 0, 0);

function wire(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

type Reply = { status: number; headers: Map<string, string>; body: string; raw: string };

function parseReply(bytes: Uint8Array): Reply {
  const raw = dec.decode(bytes);
  const split = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, split).split("\r\n");
  const status = Number(head[0].split(" ")[1]);
  const headers = new Map<string, string>();
  for (const line of head.slice(1)) {
    const at = line.indexOf(":");
    headers.set(line.slice(0, at).toLowerCase(), line.slice(at + 1).trim());
  }
  return { status, headers, body: raw.slice(split + 4), raw };
}

function get(request: string): { reply: Reply; consumed: number; keepAlive: boolean } {
  const r = handle(wire(request), NOW);
  if (!r.ready) throw new Error(`the server wanted more bytes for ${JSON.stringify(request)}`);
  return { reply: parseReply(r.response), consumed: r.consumed, keepAlive: r.keepAlive };
}

Deno.test("every route answers", () => {
  const cases: Array<[string, number, string]> = [
    ["GET / HTTP/1.1\r\nHost: a\r\n\r\n", 200, "wac http server\n"],
    ["GET /time HTTP/1.1\r\nHost: a\r\n\r\n", 200, '{"now":"2020-06-15T10:00:00.000Z"}'],
    ["GET /echo?a=1&b=hello+world HTTP/1.1\r\nHost: a\r\n\r\n", 200, '{"a":"1","b":"hello world"}'],
    ["GET /echo HTTP/1.1\r\nHost: a\r\n\r\n", 200, "{}"],
    ["GET /b64/aGVsbG8 HTTP/1.1\r\nHost: a\r\n\r\n", 200, "hello"],
    ["GET /nope HTTP/1.1\r\nHost: a\r\n\r\n", 404, "no route\n"],
  ];
  for (const [request, status, body] of cases) {
    const { reply } = get(request);
    if (reply.status !== status) {
      throw new Error(`${JSON.stringify(request)}: status ${reply.status}, want ${status}`);
    }
    if (reply.body !== body) {
      throw new Error(`${JSON.stringify(request)}: body ${JSON.stringify(reply.body)}, want ${JSON.stringify(body)}`);
    }
  }
});

Deno.test("the routes go through the packages they claim to", () => {
  // Each of these fails if the package behind it is not actually on the path.
  const { reply: json } = get(
    "POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 36\r\n\r\n" + '{"b":1,"a":[1,2,{"c":true}],"n":1e2}',
  );
  // `1e2` surviving as written is `packages/json` keeping the source span — a re-formatter would
  // have made it 100.
  if (json.body !== '{"b":1,"a":[1,2,{"c":true}],"n":1e2}') {
    throw new Error(`json route: ${json.body}`);
  }

  const { reply: match } = get("GET /match/(%5Cw%2B)%40(%5Cw%2B)/mail%20a%40b HTTP/1.1\r\nHost: a\r\n\r\n");
  if (match.body !== '{"matched":true,"groups":["a@b","a","b"],"start":5}') {
    throw new Error(`match route: ${match.body}`);
  }

  // Percent-decoding in the path is `packages/url`; base64url is `packages/codec`.
  const { reply: b64 } = get("GET /b64/aGVsbG8gd29ybGQ HTTP/1.1\r\nHost: a\r\n\r\n");
  if (b64.body !== "hello world") throw new Error(`b64 route: ${b64.body}`);
});

Deno.test("bad input to a route is a 400, not a crash", () => {
  const cases: Array<[string, number]> = [
    ["POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 4\r\n\r\n{bad", 400],
    ["POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 9\r\n\r\n{\"a\":1} x", 400],
    ["GET /b64/!!!! HTTP/1.1\r\nHost: a\r\n\r\n", 400],
    ["GET /match/(%3F%3Da)/x HTTP/1.1\r\nHost: a\r\n\r\n", 400],
    ["DELETE / HTTP/1.1\r\nHost: a\r\n\r\n", 405],
    ["GET /json HTTP/1.1\r\nHost: a\r\n\r\n", 405],
  ];
  for (const [request, status] of cases) {
    const { reply } = get(request);
    if (reply.status !== status) {
      throw new Error(`${JSON.stringify(request)}: status ${reply.status}, want ${status}`);
    }
  }
  // 405 says what is allowed, which is the part of the status that is actually useful.
  const { reply } = get("DELETE / HTTP/1.1\r\nHost: a\r\n\r\n");
  if (reply.headers.get("allow") !== "GET, HEAD") throw new Error("405 without a usable Allow");
});

Deno.test("HEAD sends the headers a GET would and no body", () => {
  const { reply: head } = get("HEAD / HTTP/1.1\r\nHost: a\r\n\r\n");
  const { reply: full } = get("GET / HTTP/1.1\r\nHost: a\r\n\r\n");
  if (head.body !== "") throw new Error(`HEAD returned a body: ${JSON.stringify(head.body)}`);
  // The Content-Length is the one the GET would have had. That is the point of HEAD, and the one
  // place where the header and the bytes on the wire are meant to disagree.
  if (head.headers.get("content-length") !== full.headers.get("content-length")) {
    throw new Error(`HEAD Content-Length ${head.headers.get("content-length")} vs GET ${full.headers.get("content-length")}`);
  }
});

Deno.test("consumed is exactly one message, so pipelining works", () => {
  const first = "GET / HTTP/1.1\r\nHost: a\r\n\r\n";
  const second = "GET /time HTTP/1.1\r\nHost: a\r\n\r\n";
  const both = handle(wire(first + second), NOW);
  if (!both.ready) throw new Error("the server wanted more bytes for a complete pair");
  // TypeScript needs the narrowing kept in scope; the assertion above is the real check.
  if (both.consumed !== first.length) {
    throw new Error(`consumed ${both.consumed}, the first message is ${first.length} bytes`);
  }
  // The remainder is the second request, untouched, and answers on its own.
  const rest = handle(wire(first + second).subarray(both.consumed), NOW);
  if (!rest.ready) throw new Error("the second request did not parse");
  if (parseReply(rest.response).body !== '{"now":"2020-06-15T10:00:00.000Z"}') {
    throw new Error("the second request answered wrong");
  }

  // A body-carrying request is the case where getting this wrong is easy.
  const post = "POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 7\r\n\r\n{\"a\":1}";
  const piped = handle(wire(post + second), NOW);
  if (!piped.ready) throw new Error("the pipelined POST was not answered");
  if (piped.consumed !== post.length) {
    throw new Error(`consumed ${piped.consumed} of a ${post.length}-byte POST`);
  }
});

Deno.test("an incomplete request is not an error", () => {
  const full = "POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 7\r\n\r\n{\"a\":1}";
  for (let n = 0; n < full.length; n++) {
    const r = handle(wire(full.slice(0, n)), NOW);
    if (r.ready) {
      throw new Error(`answered a ${n}-byte prefix of a ${full.length}-byte request`);
    }
  }
  if (!handle(wire(full), NOW).ready) throw new Error("did not answer the complete request");
});

Deno.test("keep-alive follows the version and the Connection field", () => {
  const cases: Array<[string, boolean]> = [
    ["GET / HTTP/1.1\r\nHost: a\r\n\r\n", true],
    ["GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n", false],
    ["GET / HTTP/1.1\r\nHost: a\r\nConnection: CLOSE\r\n\r\n", false],
    // 1.0 is the other way round: closed unless the client asks. Getting this backwards leaves a
    // 1.0 client waiting for a response it has already been sent.
    ["GET / HTTP/1.0\r\n\r\n", false],
    ["GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n", true],
  ];
  for (const [request, want] of cases) {
    const { keepAlive, reply } = get(request);
    if (keepAlive !== want) {
      throw new Error(`${JSON.stringify(request)}: keepAlive ${keepAlive}, want ${want}`);
    }
    // And the header says the same thing, which is what the client acts on.
    const said = reply.headers.get("connection");
    if (said !== (want ? "keep-alive" : "close")) {
      throw new Error(`${JSON.stringify(request)}: Connection: ${said}`);
    }
  }
});

Deno.test("a malformed request is answered and the connection closed", () => {
  // Once the framing is in doubt the byte stream is no longer a sequence of messages, so
  // continuing on it is the smuggling condition. The answer is 400 and goodbye, whatever the
  // client asked for.
  const cases = [
    "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello",
    "GET / HTTP/1.1\r\nHost : a\r\n\r\n",
    "GET / HTTP/1.1\r\nHost: a\r\nX: 1\r\n 2\r\n\r\n",
    "GET / HTTP/2.0\r\n\r\n",
  ];
  for (const request of cases) {
    const { reply, keepAlive } = get(request);
    if (reply.status !== 400) throw new Error(`${JSON.stringify(request)}: status ${reply.status}`);
    if (keepAlive) throw new Error(`${JSON.stringify(request)}: kept the connection open`);
  }
});

Deno.test("a body past the limit is refused rather than buffered", () => {
  const { reply, keepAlive } = get("POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 99999999\r\n\r\n");
  if (reply.status !== 413) throw new Error(`status ${reply.status}, want 413`);
  if (keepAlive) throw new Error("kept the connection open after refusing a body");
});

Deno.test("responses are well-formed for our own parser", () => {
  // The server's output should be parseable, and the framing headers should be there exactly
  // once — a response with two Content-Lengths is the same bug as a request with two.
  for (
    const request of [
      "GET / HTTP/1.1\r\nHost: a\r\n\r\n",
      "HEAD / HTTP/1.1\r\nHost: a\r\n\r\n",
      "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n",
      "DELETE / HTTP/1.1\r\nHost: a\r\n\r\n",
    ]
  ) {
    const { reply } = get(request);
    const lines = reply.raw.split("\r\n");
    const count = (name: string) =>
      lines.filter(l => l.toLowerCase().startsWith(`${name}:`)).length;
    if (count("content-length") !== 1) throw new Error(`${request}: ${count("content-length")} Content-Lengths`);
    if (count("transfer-encoding") !== 0) throw new Error(`${request}: emitted Transfer-Encoding`);
    if (count("connection") !== 1) throw new Error(`${request}: ${count("connection")} Connection headers`);
    const declared = Number(reply.headers.get("content-length"));
    const actual = enc.encode(reply.body).length;
    const isHead = request.startsWith("HEAD");
    if (!isHead && declared !== actual) {
      throw new Error(`${request}: Content-Length ${declared}, body ${actual} bytes`);
    }
  }
});
