// Branch coverage for http.
//
// The same corpus the tests use — well-formed messages, every prefix of one, the framing
// ambiguities, and the mutation generator — because the rejection paths are most of this parser
// and only malformed input reaches them.
//
//   deno task coverage:http
//   deno task coverage:http --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");

const run = await instrument("packages/http/test/probe.wac");
const parse = run.mod.parse as (input: Uint8Array, maxBody: number) => Uint8Array;
const MAX_BODY = 1 << 20;

const wire = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
const one = (s: string): void => { parse(wire(s), MAX_BODY); };

const CASES = [
  "GET / HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /path/to?x=1&y=2 HTTP/1.1\r\nHost: example.com\r\n\r\n",
  "OPTIONS * HTTP/1.1\r\nHost: a\r\n\r\n",
  "CONNECT example.com:443 HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET http://example.com/p HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET / HTTP/1.0\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\nhello",
  "GET / HTTP/1.1\r\nHost:a\r\n\r\n",
  "GET / HTTP/1.1\r\nHost:   a   \r\n\r\n",
  "GET / HTTP/1.1\r\nX-Empty:\r\nHost: a\r\n\r\n",
  "GET / HTTP/1.1\r\nX-Tab:\tv\there\r\nHost: a\r\n\r\n",
  "\r\n\r\nGET / HTTP/1.1\r\nHost: a\r\n\r\n",
  // chunked, in every shape the decoder has a branch for
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\nA\r\n0123456789\r\n0\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\ntransfer-encoding: CHUNKED\r\n\r\n0\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n0\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Trailer: v\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n X: v\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX v\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n:v\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX: \x01\r\n\r\n",
  // the framing refusals
  "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello",
  "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: +5\r\n\r\nhello",
  "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: \r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 99999999\r\n\r\n",
  "GET / HTTP/1.1\r\nHost: a\r\nX: 1\r\n 2\r\n\r\n",
  "GET / HTTP/1.1\r\nHost : a\r\n\r\n",
  // malformed request lines
  "\r\n\r\n", "GET\r\n\r\n", "GET /\r\n\r\n", "GET / HTTP/1.1x\r\n\r\n", "GET / HTTP/2.0\r\n\r\n",
  "GET / HTTP/1\r\n\r\n", "GET / http/1.1\r\n\r\n", " GET / HTTP/1.1\r\n\r\n",
  "GET  / HTTP/1.1\r\n\r\n", "GE T / HTTP/1.1\r\n\r\n", "GET x HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /a\x01b HTTP/1.1\r\nHost: a\r\n\r\n", "GET /\x80 HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET / HTTP/1.1\r\n: v\r\n\r\n", "GET / HTTP/1.1\r\nX Y: v\r\n\r\n",
  "GET / HTTP/1.1\r\nNoColon\r\n\r\n", "GET / HTTP/1.1\r\nX: \x80\r\n\r\n",
  "GET / HTTP/1.1\r\nX: \x01\r\n\r\n", "GET / HTTP/1.1\r\nHost: a\r\n\r\nGET /2 HTTP/1.1\r\n\r\n",
  // malformed chunked
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\nz\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5 \r\nhello\r\n0\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhelloX0\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\nffffffff\r\n\r\n",
];

for (const c of CASES) one(c);

/** Every prefix of a few messages, which is what reaches the `Incomplete` returns. */
for (
  const full of [
    "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\nhello",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\nX: v\r\n\r\n",
  ]
) {
  for (let n = 0; n <= full.length; n++) one(full.slice(0, n));
}

/** A small body cap, so the too-large paths are reached rather than only described. */
for (
  const c of [
    "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 100\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n64\r\n",
  ]
) parse(wire(c), 8);

/** The mutation generator, kept in step with test/fuzz.test.ts by hand. */
{
  const SEEDS = [
    "GET / HTTP/1.1\r\nHost: a\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\nhello",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
    "GET /a?b=c HTTP/1.1\r\nHost: a\r\nAccept: */*\r\nCookie: k=v\r\n\r\n",
  ];
  const INTERESTING = [13, 10, 0x20, 9, 0, 0x3a, 0x2c, 0x3b, 0x7f, 0x80, 0xff, 0x2e, 0x2d];
  let x = 0x1234abcd | 0;
  const next = (): number => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
  const dec2 = new TextDecoder();
  for (let i = 0; i < 3000; i++) {
    const base = Array.from(wire(SEEDS[next() % SEEDS.length]));
    const edits = 1 + (next() % 3);
    for (let e = 0; e < edits; e++) {
      const kind = next() % 4;
      if (kind === 0) base.splice(next() % (base.length + 1), 0, INTERESTING[next() % INTERESTING.length]);
      else if (kind === 1 && base.length > 0) base.splice(next() % base.length, 1);
      else if (kind === 2 && base.length > 0) base[next() % base.length] = INTERESTING[next() % INTERESTING.length];
      else base.length = next() % (base.length + 1);
    }
    parse(new Uint8Array(base), MAX_BODY);
    void dec2;
  }
}

/**
 * The client half: response parsing and request writing.
 *
 * Instrumented separately because it is a different entry point — `probe.wac` is the server side
 * and cannot reach `incoming.wac` at all.
 */
const clientRun = await instrument("packages/http/test/client_probe.wac");
{
  const parseResponse = clientRun.mod.parse as
    (input: Uint8Array, method: Uint8Array, eof: boolean, maxBody: number) => Uint8Array;
  const build = clientRun.mod.buildRequest as (
    method: Uint8Array, target: Uint8Array, host: Uint8Array, headers: Uint8Array,
    body: Uint8Array, keepAlive: boolean,
  ) => Uint8Array;
  const enc2 = new TextEncoder();
  const resp = (s: string, method = "GET", eof = true): void => {
    parseResponse(wire(s), enc2.encode(method), eof, MAX_BODY);
  };

  for (
    const [bytes, method] of [
      ["HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello", "GET"],
      ["HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nContent-Length:5\r\n\r\nhello", "GET"],
      ["HTTP/1.1 200 OK\r\nContent-Length:   5   \r\n\r\nhello", "GET"],
      ["HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nhi", "GET"],
      ["HTTP/1.1 200\r\nContent-Length: 0\r\n\r\n", "GET"],
      ["HTTP/1.1 200 \r\nContent-Length: 0\r\n\r\n", "GET"],
      ["HTTP/1.1 999 Weird\r\nContent-Length: 0\r\n\r\n", "GET"],
      // bodyless by rule
      ["HTTP/1.1 204 No Content\r\nContent-Length: 99\r\n\r\n", "GET"],
      ["HTTP/1.1 304 Not Modified\r\n\r\n", "GET"],
      ["HTTP/1.1 100 Continue\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\n", "HEAD"],
      ["HTTP/1.1 200 Connected\r\n\r\n", "CONNECT"],
      // chunked
      ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;x=1\r\nhello\r\n0\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-T: v\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nz\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhelloX0\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n X: v\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX v\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX: \x01\r\n\r\n", "GET"],
      // close-delimited, including a non-chunked coding
      ["HTTP/1.1 200 OK\r\n\r\nuntil close", "GET"],
      ["HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\nbytes", "GET"],
      // refusals
      ["HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello", "GET"],
      ["HTTP/1.1 200 OK\r\nContent-Length: +5\r\n\r\nhello", "GET"],
      ["HTTP/1.1 200 OK\r\nContent-Length: \r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nX: 1\r\n 2\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nX : 1\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\n: 1\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nX: \x01\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\r\nContent-Length: 99999999\r\n\r\n", "GET"],
      // malformed status lines
      ["HTTP/1.1\r\n\r\n", "GET"],
      ["HTTP/1.1 \r\n\r\n", "GET"],
      ["HTTP/1.1 xyz OK\r\n\r\n", "GET"],
      ["HTTP/1.1 20 OK\r\n\r\n", "GET"],
      ["HTTP/2.0 200 OK\r\n\r\n", "GET"],
      ["HTTP/1.1200 OK\r\n\r\n", "GET"],
      ["HTTP/1.x 200 OK\r\n\r\n", "GET"],
      ["hello\r\n\r\n", "GET"],
      ["HTTP/1.1 200 OK\x01\r\n\r\n", "GET"],
    ] as Array<[string, string]>
  ) resp(bytes, method);

  /** Every prefix, which is what reaches the Incomplete returns on the response side. */
  for (
    const full of [
      "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\nX: v\r\n\r\n",
    ]
  ) {
    for (let n = 0; n <= full.length; n++) resp(full.slice(0, n), "GET", false);
  }

  /** The request writer, in each of its shapes. */
  for (
    const [method, target, headers, body, keepAlive] of [
      ["GET", "/", "", "", true],
      ["GET", "/", "", "", false],
      ["POST", "/x", "Accept\0*/*", "hello", true],
      ["PUT", "/a?b=c", "A\x001\0B\x002", '{"a":1}', false],
      ["DELETE", "/x", "", "", true],
    ] as Array<[string, string, string, string, boolean]>
  ) {
    build(enc2.encode(method), enc2.encode(target), enc2.encode("example.com"),
          enc2.encode(headers), enc2.encode(body), keepAlive);
  }
}

/**
 * The response *writer* is only reachable through a server, so the server's probe is a third
 * entry point here. Its own report filters to `packages/server/` and would show `response.wac` as
 * dead; this one filters to `packages/http/` and sees it.
 */
const serverRun = await instrument("packages/server/test/probe.wac");
{
  const serve = serverRun.mod.handle as (input: Uint8Array, now: bigint) => Uint8Array;
  const now = BigInt(Date.UTC(2020, 5, 15));
  for (
    const request of [
      "GET / HTTP/1.1\r\nHost: a\r\n\r\n",
      "HEAD / HTTP/1.1\r\nHost: a\r\n\r\n",
      "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n",
      "DELETE / HTTP/1.1\r\nHost: a\r\n\r\n",
      "GET / HTTP/1.0\r\n\r\n",
      "GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
      "GET / HTTP/2.0\r\n\r\n",
      "POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 99999999\r\n\r\n",
      "POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 7\r\n\r\n{\"a\":1}",
    ]
  ) serve(wire(request), now);
}

report([run, clientRun, serverRun], "packages/http/", { verbose });
