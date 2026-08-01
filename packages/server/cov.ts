// Branch coverage for server.
//
// Drives `serve` directly with the same requests the tests use. The routes are most of the branch
// points and the error paths are the rest, so the corpus is the union of "every route" and "every
// way a route can be given something it cannot use".
//
//   deno task coverage:server
//   deno task coverage:server --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");
const NOW = BigInt(Date.UTC(2020, 5, 15, 10, 0, 0));

const run = await instrument("packages/server/test/probe.wac");
const handle = run.mod.handle as (input: Uint8Array, now: bigint) => Uint8Array;

const wire = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
const one = (s: string): void => {
  handle(wire(s), NOW);
};

const REQUESTS = [
  // every route, and each of its methods
  "GET / HTTP/1.1\r\nHost: a\r\n\r\n",
  "HEAD / HTTP/1.1\r\nHost: a\r\n\r\n",
  "DELETE / HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /time HTTP/1.1\r\nHost: a\r\n\r\n",
  "POST /time HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\n\r\n",
  "GET /echo HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /echo?a=1 HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /echo?a=1&b=2&c HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /echo?a=hello+world&b=%41%42 HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /echo?&&a=1&& HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /echo?%22q%22=a%00b HTTP/1.1\r\nHost: a\r\n\r\n",
  "POST /echo HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\n\r\n",
  "POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 7\r\n\r\n{\"a\":1}",
  "POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 4\r\n\r\n{bad",
  "POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 2\r\n\r\n[]",
  "GET /json HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /b64/aGVsbG8 HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /b64/aGVsbG8gd29ybGQ HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /b64/!!!! HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /b64 HTTP/1.1\r\nHost: a\r\n\r\n",
  "POST /b64/aGk HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\n\r\n",
  "GET /match/a/abc HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /match/(a)(b)%3F/ab HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /match/(a)(b)%3F/ac HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /match/z/abc HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /match/(%3F%3Da)/x HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /match/(a%7Ca)%2Bb/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa HTTP/1.1\r\nHost: a\r\n\r\n",
  "POST /match/a/b HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\n\r\n",
  "GET /nope HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET /a/b/c/d HTTP/1.1\r\nHost: a\r\n\r\n",
  "GET http://server.invalid/time HTTP/1.1\r\nHost: a\r\n\r\n",
  // keep-alive decisions
  "GET / HTTP/1.0\r\n\r\n",
  "GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n",
  "GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
  // rejections
  "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
  "GET / HTTP/1.1\r\nHost : a\r\n\r\n",
  "GET / HTTP/2.0\r\n\r\n",
  "POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 99999999\r\n\r\n",
  "GET /\x7f HTTP/1.1\r\nHost: a\r\n\r\n",
  // chunked in, which routes the same as any other body
  "POST /json HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"a\":1}\r\n0\r\n\r\n",
];

for (const r of REQUESTS) one(r);

/** Every prefix of a request, which is what reaches the `Incomplete` return. */
{
  const full = "POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 7\r\n\r\n{\"a\":1}";
  for (let n = 0; n <= full.length; n++) one(full.slice(0, n));
}

/** Pipelined pairs, so `consumed` is exercised with something after it. */
for (
  const first of [
    "GET / HTTP/1.1\r\nHost: a\r\n\r\n",
    "POST /json HTTP/1.1\r\nHost: a\r\nContent-Length: 7\r\n\r\n{\"a\":1}",
  ]
) {
  one(first + "GET /time HTTP/1.1\r\nHost: a\r\n\r\n");
}

report([run], "packages/server/", { verbose });
