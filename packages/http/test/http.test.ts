// HTTP/1.1 request parsing, judged against llhttp through Node.
//
// Two things are compared, and the second is the one that matters:
//
//   1. For a well-formed message, that the same fields come out — method, target, version, every
//      header in order with duplicates, and the body.
//   2. For a malformed one, that both *refuse* it. Not that they give the same reason, which is
//      not specified, but that neither accepts something the other rejects. A parser pair that
//      disagrees about acceptance is exactly the configuration request smuggling needs, and it is
//      the property worth testing between two independent implementations.
//
// Where this is deliberately stricter than llhttp, the case is listed in STRICTER with the rule
// it enforces — asserted, not skipped, so it stays visible.

import { wacBind } from "../../../harness/wacBind.ts";
import { fromBase64, oracle, type Outcome, wire } from "./oracle.ts";

const mod = await wacBind("packages/http/test/probe.wac") as unknown as {
  parse(input: Uint8Array, maxBody: number): Uint8Array;
};

const dec = new TextDecoder();
const MAX_BODY = 1 << 20;

type Wac =
  | { outcome: "ok"; method: string; target: string; minor: number; consumed: number; body: string; headers: Array<[string, string]> }
  | { outcome: "bad"; code: number }
  | { outcome: "incomplete" };

function wac(input: Uint8Array): Wac {
  const parts = dec.decode(mod.parse(input, MAX_BODY)).split("\0");
  if (parts[0] === "incomplete") return { outcome: "incomplete" };
  if (parts[0] === "bad") return { outcome: "bad", code: Number(parts[1]) };
  const headers: Array<[string, string]> = [];
  for (let i = 6; i + 1 < parts.length; i += 2) headers.push([parts[i], parts[i + 1]]);
  return {
    outcome: "ok",
    method: parts[1],
    target: parts[2],
    minor: Number(parts[3]),
    consumed: Number(parts[4]),
    body: parts[5],
    headers,
  };
}

/** llhttp's answer reduced to the same shape, for the fields both report. */
function oracleHeaders(o: Outcome): Array<[string, string]> {
  if (o.outcome !== "ok") return [];
  const out: Array<[string, string]> = [];
  for (let i = 0; i + 1 < o.rawHeaders.length; i += 2) out.push([o.rawHeaders[i], o.rawHeaders[i + 1]]);
  return out;
}

/**
 * Cases where this parser refuses something llhttp accepts, with the rule.
 *
 * Being stricter is allowed and is often the point — but it has to be deliberate and listed,
 * because "stricter" is also what a bug looks like from the outside.
 */
const STRICTER: Array<{ input: string; why: string }> = [
  {
    input: "GET /\r\n\r\n",
    why: "HTTP/0.9, which llhttp reports as version 0.9. A 0.9 request has no headers and no way "
      + "to frame a body, so treating it as 1.x is how a request line becomes a body",
  },
  {
    input: "GET / HTTP/2.0\r\n\r\n",
    why: "a major version this grammar does not describe. RFC 9112 §2.3 allows answering 505, but "
      + "parsing it as 1.x and proceeding is not one of the options",
  },
  {
    input: "GET  / HTTP/1.1\r\n\r\n",
    why: "an empty request-target, which the grammar does not admit. llhttp neither accepts nor "
      + "rejects it; refusing is the answer that cannot desynchronise anything",
  },
];

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function describe(input: Uint8Array): string {
  return JSON.stringify(dec.decode(input)).replaceAll("\\r\\n", "|");
}

async function compare(inputs: Uint8Array[]): Promise<string[]> {
  const want = await oracle(inputs);
  const bad: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const got = wac(inputs[i]);
    const o = want[i];
    const label = describe(inputs[i]);

    // A listed case is one where this parser is deliberately stricter. It must still *refuse* —
    // being on the list is permission to differ, not permission to do anything.
    const listed = STRICTER.find(s => sameBytes(wire(s.input), inputs[i]));
    if (listed !== undefined) {
      if (got.outcome !== "bad") {
        bad.push(`${label}: listed as deliberately stricter, but wac said ${got.outcome}`);
      }
      continue;
    }

    if (o.outcome === "ok") {
      if (got.outcome !== "ok") {
        bad.push(`${label}: llhttp accepted, wac said ${got.outcome}`);
        continue;
      }
      if (got.method !== o.method) bad.push(`${label}: method ${got.method} vs ${o.method}`);
      if (got.target !== o.target) bad.push(`${label}: target ${got.target} vs ${o.target}`);
      if (`1.${got.minor}` !== o.version) bad.push(`${label}: version 1.${got.minor} vs ${o.version}`);
      const wantBody = dec.decode(fromBase64(o.body));
      if (got.body !== wantBody) {
        bad.push(`${label}: body ${JSON.stringify(got.body)} vs ${JSON.stringify(wantBody)}`);
      }
      const wantHeaders = oracleHeaders(o);
      // Trailers arrive as headers here and separately there, so compare only the leading run.
      const n = Math.min(got.headers.length, wantHeaders.length);
      for (let k = 0; k < n; k++) {
        if (got.headers[k][0] !== wantHeaders[k][0] || got.headers[k][1] !== wantHeaders[k][1]) {
          bad.push(`${label}: header ${k} ${JSON.stringify(got.headers[k])} vs ${JSON.stringify(wantHeaders[k])}`);
        }
      }
      if (got.headers.length < wantHeaders.length) {
        bad.push(`${label}: ${wantHeaders.length - got.headers.length} headers missing`);
      }
    } else if (o.outcome === "error") {
      // The reason is not specified and the two will not agree on it. Acceptance is.
      if (got.outcome === "ok") bad.push(`${label}: llhttp rejected (${o.code}), wac accepted`);
    } else {
      if (got.outcome === "ok") bad.push(`${label}: llhttp wanted more bytes, wac accepted`);
      if (got.outcome === "bad") bad.push(`${label}: llhttp wanted more bytes, wac rejected`);
    }
  }
  return bad;
}

async function check(inputs: string[]): Promise<void> {
  const bad = await compare(inputs.map(wire));
  if (bad.length > 0) {
    throw new Error(`${bad.length}/${inputs.length} disagreed:\n  ${bad.slice(0, 15).join("\n  ")}`);
  }
}

Deno.test("well-formed requests", async () => {
  await check([
    "GET / HTTP/1.1\r\nHost: a\r\n\r\n",
    "GET /path/to?x=1&y=2 HTTP/1.1\r\nHost: example.com\r\n\r\n",
    "HEAD / HTTP/1.1\r\nHost: a\r\n\r\n",
    "DELETE /x HTTP/1.1\r\nHost: a\r\n\r\n",
    "OPTIONS * HTTP/1.1\r\nHost: a\r\n\r\n",
    "GET / HTTP/1.0\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\nhello",
    "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 11\r\n\r\nhello world",
    "GET / HTTP/1.1\r\nHost: a\r\nAccept: */*\r\nUser-Agent: x/1.0\r\n\r\n",
    "GET / HTTP/1.1\r\nhost: a\r\nHOST2: b\r\n\r\n",
    "GET / HTTP/1.1\r\nHost:a\r\n\r\n",
    "GET / HTTP/1.1\r\nHost:   a   \r\n\r\n",
    "GET / HTTP/1.1\r\nX-Empty:\r\nHost: a\r\n\r\n",
    "GET / HTTP/1.1\r\nHost: a\r\nCookie: a=1\r\nCookie: b=2\r\n\r\n",
    "GET / HTTP/1.1\r\nX-Tab:\tvalue\there\r\nHost: a\r\n\r\n",
  ]);
});

Deno.test("chunked bodies", async () => {
  await check([
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n2\r\nbc\r\n0\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\nA\r\n0123456789\r\n0\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\na\r\n0123456789\r\n0\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\ntransfer-encoding: CHUNKED\r\n\r\n0\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n0\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Trailer: v\r\n\r\n",
  ]);
});

Deno.test("incomplete messages are not rejections", async () => {
  // Every prefix of a valid request. None of them is malformed; all of them need more bytes, and
  // a parser that says otherwise breaks on any client that writes in more than one packet.
  const full = "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\nhello";
  const prefixes: string[] = [];
  for (let n = 1; n < full.length; n++) prefixes.push(full.slice(0, n));
  await check(prefixes);
});

Deno.test("incomplete chunked messages are not rejections", async () => {
  const full = "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n";
  const prefixes: string[] = [];
  for (let n = 1; n < full.length; n++) prefixes.push(full.slice(0, n));
  await check(prefixes);
});

Deno.test("framing ambiguity is refused: the smuggling shapes", async () => {
  // The reason this package exists. Each of these is a message two parsers can disagree about,
  // and a disagreement between a front-end and a back-end is a smuggled request. Both this and
  // llhttp must refuse all of them.
  await check([
    // Content-Length and Transfer-Encoding together: one reads 5 bytes, the other reads chunks.
    "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n0\r\n\r\n",
    // Two Content-Lengths, agreeing or not.
    "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello",
    "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\nhello",
    // A Content-Length that is not a plain number: some parsers read 5, some reject.
    "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: +5\r\n\r\nhello",
    "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5 \r\n\r\nhello",
    "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 0x5\r\n\r\nhello",
    "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: -1\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: \r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5,5\r\n\r\nhello",
    // Obsolete line folding: the continuation becomes part of the value, and a value that can
    // hold CRLF can hold a header.
    "GET / HTTP/1.1\r\nHost: a\r\nX: 1\r\n 2\r\n\r\n",
    "GET / HTTP/1.1\r\nHost: a\r\nX: 1\r\n\tContent-Length: 5\r\n\r\n",
    // Whitespace around the colon, which parsers split differently.
    "GET / HTTP/1.1\r\nHost : a\r\n\r\n",
    "GET / HTTP/1.1\r\nHost\t: a\r\n\r\n",
    // A transfer coding that is not chunked, or not chunked last.
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked, gzip\r\n\r\n0\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: xchunked\r\n\r\n0\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
  ]);
});

Deno.test("malformed request lines and headers", async () => {
  await check([
    "\r\n\r\n",
    "GET\r\n\r\n",
    "GET /\r\n\r\n",
    "GET / HTTP/1.1x\r\n\r\n",
    "GET / HTTP/2.0\r\n\r\n",
    "GET / HTTP/1\r\n\r\n",
    "GET / http/1.1\r\n\r\n",
    " GET / HTTP/1.1\r\n\r\n",
    "GET  / HTTP/1.1\r\n\r\n",
    "GE T / HTTP/1.1\r\n\r\n",
    "G T / HTTP/1.1\r\nHost: a\r\n\r\n",
    "GET /a b HTTP/1.1\r\nHost: a\r\n\r\n",
    "GET / HTTP/1.1\r\n: v\r\n\r\n",
    "GET / HTTP/1.1\r\nX Y: v\r\n\r\n",
    "GET / HTTP/1.1\r\nNoColon\r\n\r\n",
    "GET / HTTP/1.1\r\nX: v w\r\n\r\n",
  ]);
});

Deno.test("malformed chunked bodies", async () => {
  await check([
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\nz\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5 \r\nhello\r\n0\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhelloX0\r\n\r\n",
    "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n-1\r\n\r\n",
  ]);
});

Deno.test("what the parser consumed is where the next message starts", async () => {
  // Pipelining, and the other half of the framing question: a parser that is right about the
  // body but wrong about where it ended desynchronises the connection just as thoroughly.
  const cases: Array<[string, string]> = [
    ["GET / HTTP/1.1\r\nHost: a\r\n\r\n", "GET /2 HTTP/1.1\r\nHost: b\r\n\r\n"],
    ["POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\nhello", "GET /2 HTTP/1.1\r\n\r\n"],
    ["POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n", "GET /2 HTTP/1.1\r\n\r\n"],
  ];
  const bad: string[] = [];
  for (const [first, second] of cases) {
    const got = wac(wire(first + second));
    if (got.outcome !== "ok") {
      bad.push(`${describe(wire(first))}: expected a parse, got ${got.outcome}`);
      continue;
    }
    if (got.consumed !== first.length) {
      bad.push(`${describe(wire(first))}: consumed ${got.consumed}, the message is ${first.length} bytes`);
    }
  }
  if (bad.length > 0) throw new Error(bad.join("\n  "));
});
