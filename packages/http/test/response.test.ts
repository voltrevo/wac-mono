// Response parsing, judged against llhttp through Node's HTTP *client*.
//
// The mirror of `http.test.ts`, and a harder problem. Request framing is one rule; response
// framing is five, tried in order, and two of them depend on things the message does not contain
// — the method of the request it answers, and whether the connection has closed.
//
// The comparison is the same shape: for a message both accept, every field; for one either
// refuses, only acceptance. And as on the request side, llhttp is reading a *stream* — so a
// response this parser completes with bytes left over is a case where the two are answering
// different questions, and it is skipped and counted rather than reported.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/http/test/client_probe.wac") as unknown as {
  parse(input: Uint8Array, method: Uint8Array, eof: boolean, maxBody: number): Uint8Array;
  buildRequest(
    method: Uint8Array, target: Uint8Array, host: Uint8Array, headers: Uint8Array,
    body: Uint8Array, keepAlive: boolean,
  ): Uint8Array;
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX_BODY = 1 << 20;

function wire(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

type Wac =
  | { outcome: "ok"; status: number; minor: number; consumed: number; closeDelimited: boolean; body: string; headers: Array<[string, string]> }
  | { outcome: "bad"; code: number }
  | { outcome: "incomplete" };

function wac(input: Uint8Array, method: string, eof: boolean): Wac {
  const parts = dec.decode(mod.parse(input, enc.encode(method), eof, MAX_BODY)).split("\0");
  if (parts[0] === "incomplete") return { outcome: "incomplete" };
  if (parts[0] === "bad") return { outcome: "bad", code: Number(parts[1]) };
  const headers: Array<[string, string]> = [];
  for (let i = 6; i + 1 < parts.length; i += 2) headers.push([parts[i], parts[i + 1]]);
  return {
    outcome: "ok",
    status: Number(parts[1]),
    minor: Number(parts[2]),
    consumed: Number(parts[3]),
    closeDelimited: parts[4] === "1",
    body: parts[5],
    headers,
  };
}

type Outcome =
  | { outcome: "ok"; status: number; version: string; rawHeaders: string[]; body: string }
  | { outcome: "error"; code: string }
  | { outcome: "incomplete" };

async function oracle(cases: Array<{ bytes: Uint8Array; method: string }>): Promise<Outcome[]> {
  if (cases.length === 0) return [];
  const payload = JSON.stringify(cases.map(c => {
    let s = "";
    for (const b of c.bytes) s += String.fromCharCode(b);
    return { bytes: btoa(s), method: c.method };
  }));
  const command = new Deno.Command("node", {
    args: ["packages/http/test/response_oracle.mjs"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(enc.encode(payload));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) throw new Error(`the response oracle failed: ${dec.decode(stderr)}`);
  return JSON.parse(dec.decode(stdout)) as Outcome[];
}

function fromBase64(s: string): string {
  return atob(s);
}

/**
 * Responses llhttp accepts and this refuses, with the rule. Listed rather than skipped, and each
 * must still be *refused* — being on the list is permission to differ, not to do anything.
 */
const STRICTER: Array<{ bytes: string; why: string }> = [
  {
    bytes: "HTTP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n",
    why: "a major version this grammar does not describe. An HTTP/2 frame is not an HTTP/1 "
      + "message, and reading one as the other is how a connection desynchronises",
  },
];

async function check(cases: Array<[string, string]>): Promise<void> {
  const inputs = cases.map(([bytes, method]) => ({ bytes: wire(bytes), method }));
  const want = await oracle(inputs);
  const bad: string[] = [];
  let skipped = 0;

  for (let i = 0; i < inputs.length; i++) {
    // The connection closes after the bytes, so `eof` is true — that is what completes a
    // close-delimited body, and it is what the oracle's server does too.
    const got = wac(inputs[i].bytes, inputs[i].method, true);
    const o = want[i];
    const label = `${inputs[i].method} ${JSON.stringify(cases[i][0]).replaceAll("\\r\\n", "|")}`;

    // Bytes left over means llhttp went on to read them as another response and this parser did
    // not. Different questions; not a disagreement. The commonest case is a HEAD response with a
    // body in the stream, which is exactly the trap this parser exists to avoid.
    if (got.outcome === "ok" && got.consumed < inputs[i].bytes.length) {
      skipped++;
      continue;
    }

    const listed = STRICTER.find(x => x.bytes === cases[i][0]);
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
      if (got.status !== o.status) bad.push(`${label}: status ${got.status} vs ${o.status}`);
      if (`1.${got.minor}` !== o.version) bad.push(`${label}: version 1.${got.minor} vs ${o.version}`);
      const wantBody = fromBase64(o.body);
      if (got.body !== wantBody) {
        bad.push(`${label}: body ${JSON.stringify(got.body)} vs ${JSON.stringify(wantBody)}`);
      }
      const wantHeaders: Array<[string, string]> = [];
      for (let k = 0; k + 1 < o.rawHeaders.length; k += 2) {
        wantHeaders.push([o.rawHeaders[k], o.rawHeaders[k + 1]]);
      }
      for (let k = 0; k < Math.min(got.headers.length, wantHeaders.length); k++) {
        if (got.headers[k][0] !== wantHeaders[k][0] || got.headers[k][1] !== wantHeaders[k][1]) {
          bad.push(`${label}: header ${k} ${JSON.stringify(got.headers[k])} vs ${JSON.stringify(wantHeaders[k])}`);
        }
      }
    } else if (o.outcome === "error") {
      if (got.outcome === "ok") bad.push(`${label}: llhttp rejected (${o.code}), wac accepted`);
    }
    // llhttp "incomplete" is not compared: its client gives up on a timer, which says nothing
    // about the bytes.
  }
  if (bad.length > 0) {
    throw new Error(`${bad.length}/${cases.length} disagreed (${skipped} skipped):\n  ${bad.slice(0, 12).join("\n  ")}`);
  }
}

Deno.test("well-formed responses", async () => {
  await check([
    ["HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello", "GET"],
    ["HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", "GET"],
    ["HTTP/1.1 404 Not Found\r\nContent-Length: 3\r\n\r\nabc", "GET"],
    ["HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n", "GET"],
    ["HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nhi", "GET"],
    ["HTTP/1.1 200 OK\r\nX-A: 1\r\nX-B: 2\r\nContent-Length: 0\r\n\r\n", "GET"],
    ["HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 0\r\n\r\n", "GET"],
    ["HTTP/1.1 200 OK\r\nContent-Length:5\r\n\r\nhello", "GET"],
    ["HTTP/1.1 200 OK\r\nContent-Length:   5   \r\n\r\nhello", "GET"],
    ["HTTP/1.1 999 Weird\r\nContent-Length: 0\r\n\r\n", "GET"],
    ["HTTP/1.1 200\r\nContent-Length: 0\r\n\r\n", "GET"],
    ["HTTP/1.1 200 \r\nContent-Length: 0\r\n\r\n", "GET"],
  ]);
});

Deno.test("chunked responses", async () => {
  await check([
    ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", "GET"],
    ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n", "GET"],
    ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n2\r\nbc\r\n0\r\n\r\n", "GET"],
    ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nA\r\n0123456789\r\n0\r\n\r\n", "GET"],
    ["HTTP/1.1 200 OK\r\ntransfer-encoding: CHUNKED\r\n\r\n0\r\n\r\n", "GET"],
    ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;x=1\r\nhello\r\n0\r\n\r\n", "GET"],
    ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Trailer: v\r\n\r\n", "GET"],
  ]);
});

Deno.test("bodies that are not there whatever the headers say", async () => {
  // Rule 1: HEAD, 1xx, 204 and 304 have no body. The Content-Length is kept, because a caller may
  // want to know what the GET would have returned, but no bytes belong to this message.
  await check([
    ["HTTP/1.1 204 No Content\r\n\r\n", "GET"],
    ["HTTP/1.1 304 Not Modified\r\nContent-Length: 99\r\n\r\n", "GET"],
    ["HTTP/1.1 204 No Content\r\nContent-Length: 99\r\n\r\n", "GET"],
    ["HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\n", "HEAD"],
    ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n", "HEAD"],
  ]);

  // And directly, since the oracle cannot see the distinction: a HEAD response must consume only
  // its headers, so a following response is still there to be read. A client that waited for 99
  // bytes here would read the next response as this one's body.
  const stream = "HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n";
  const first = wac(wire(stream), "HEAD", false);
  if (first.outcome !== "ok") throw new Error(`HEAD response: ${first.outcome}`);
  if (first.body !== "") throw new Error(`HEAD response had a body: ${JSON.stringify(first.body)}`);
  const rest = wire(stream).subarray(first.consumed);
  const second = wac(rest, "GET", false);
  if (second.outcome !== "ok" || second.status !== 204) {
    throw new Error(`the response after a HEAD did not parse: ${JSON.stringify(second)}`);
  }
});

Deno.test("a body delimited by the connection closing", async () => {
  // Rule 5, and the reason `parseResponse` takes `eof`: with no length and no chunking, "the
  // message is complete" and "the connection ended" are the same statement.
  await check([
    ["HTTP/1.1 200 OK\r\n\r\nuntil close", "GET"],
    ["HTTP/1.1 200 OK\r\n\r\n", "GET"],
    ["HTTP/1.1 200 OK\r\nX: 1\r\n\r\nbody here", "GET"],
  ]);

  // Before EOF the same bytes are incomplete, not complete-with-a-short-body. Getting this wrong
  // truncates every close-delimited response at a packet boundary.
  const bytes = wire("HTTP/1.1 200 OK\r\n\r\nuntil close");
  const early = wac(bytes, "GET", false);
  if (early.outcome !== "incomplete") {
    throw new Error(`without eof: ${early.outcome}, want incomplete`);
  }
  const late = wac(bytes, "GET", true);
  if (late.outcome !== "ok" || late.body !== "until close") {
    throw new Error(`with eof: ${JSON.stringify(late)}`);
  }
  if (!late.closeDelimited) throw new Error("closeDelimited was not reported");
});

Deno.test("ambiguous framing is refused", async () => {
  await check([
    ["HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", "GET"],
    ["HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello", "GET"],
    ["HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\nhello", "GET"],
    ["HTTP/1.1 200 OK\r\nContent-Length: +5\r\n\r\nhello", "GET"],
    ["HTTP/1.1 200 OK\r\nContent-Length: \r\n\r\n", "GET"],
    ["HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n", "GET"],
    ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked, gzip\r\n\r\n0\r\n\r\n", "GET"],
    ["HTTP/1.1 200 OK\r\nX: 1\r\n 2\r\nContent-Length: 0\r\n\r\n", "GET"],
    ["HTTP/1.1 200 OK\r\nX : 1\r\nContent-Length: 0\r\n\r\n", "GET"],
  ]);
});

Deno.test("malformed status lines", async () => {
  await check([
    ["HTTP/1.1\r\n\r\n", "GET"],
    ["HTTP/1.1 \r\n\r\n", "GET"],
    ["HTTP/1.1 xyz OK\r\n\r\n", "GET"],
    ["HTTP/1.1 20 OK\r\n\r\n", "GET"],
    ["HTTP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n", "GET"],
    ["HTTP/1.1200 OK\r\n\r\n", "GET"],
    ["hello\r\n\r\n", "GET"],
    ["\r\n\r\n", "GET"],
    ["HTTP/1.1 099 Low\r\nContent-Length: 0\r\n\r\n", "GET"],
  ]);
});

Deno.test("incomplete responses are not rejections", async () => {
  // Every prefix of a Content-Length response. None is malformed; each needs more bytes. `eof` is
  // false because a truncated response is what a still-open connection looks like.
  const full = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello";
  for (let n = 0; n < full.length; n++) {
    const got = wac(wire(full.slice(0, n)), "GET", false);
    if (got.outcome !== "incomplete") {
      throw new Error(`a ${n}-byte prefix was ${got.outcome}, want incomplete`);
    }
  }
  const chunked = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n";
  for (let n = 0; n < chunked.length; n++) {
    const got = wac(wire(chunked.slice(0, n)), "GET", false);
    if (got.outcome !== "incomplete") {
      throw new Error(`a ${n}-byte chunked prefix was ${got.outcome}, want incomplete`);
    }
  }
});

Deno.test("the request writer produces what our own parser reads back", async () => {
  // A round trip through the two halves, and then the same bytes past llhttp, so this is not
  // merely the writer and parser agreeing with each other.
  const cases: Array<[string, string, string]> = [
    ["GET", "/", ""],
    ["POST", "/x", "hello"],
    ["PUT", "/a/b?c=d", '{"a":1}'],
    ["DELETE", "/x", ""],
  ];
  const requests: Uint8Array[] = [];
  for (const [method, target, body] of cases) {
    requests.push(mod.buildRequest(
      enc.encode(method), enc.encode(target), enc.encode("example.com"),
      enc.encode("Accept\0*/*"), enc.encode(body), true,
    ));
  }
  // Every one must be a request llhttp accepts, which is the real check on the writer.
  const { oracle: requestOracle } = await import("./oracle.ts");
  const parsed = await requestOracle(requests);
  for (let i = 0; i < cases.length; i++) {
    const o = parsed[i];
    if (o.outcome !== "ok") {
      throw new Error(`${cases[i][0]} ${cases[i][1]}: llhttp said ${o.outcome} to our request:\n${dec.decode(requests[i])}`);
    }
    if (o.method !== cases[i][0]) throw new Error(`method ${o.method}`);
    if (o.target !== cases[i][1]) throw new Error(`target ${o.target}`);
    if (atob(o.body) !== cases[i][2]) throw new Error(`body ${atob(o.body)}`);
  }
});

Deno.test("a malformed status line says so specifically", () => {
  // Mutation testing found `ERR_STATUS` collapsible to zero with nothing noticing: the tests
  // above check that a bad response is refused and compare acceptance against llhttp, which
  // does not constrain *which* reason we give. A code naming a cause that did not happen is
  // worse than no code.
  // A line with no status *field* is a line-structure error, not a status one — the parser
  // says ERR_LINE for that, which is right and is why it is not in this list.
  for (const text of [
    "HTTP/1.1 20 OK\r\n\r\n",              // too few status digits
    "HTTP/1.1 2O0 OK\r\n\r\n",             // a letter among them
    "HTTP/1.1 abc OK\r\n\r\n",             // no digits at all, but the right shape
  ]) {
    const got = wac(enc.encode(text), "GET", true);
    if (got.outcome !== "bad") throw new Error(`${JSON.stringify(text)}: got ${got.outcome}`);
    if (got.code !== 11) throw new Error(`${JSON.stringify(text)}: code ${got.code}, want 11 (ERR_STATUS)`);
  }
});

Deno.test("a 2xx to CONNECT has no body, whatever it claims", () => {
  // The fifth framing rule, and the one nothing exercised — `isConnect` could always return
  // false and every test still passed. After a successful CONNECT the connection becomes a
  // tunnel, so bytes after the headers belong to the tunnel and not to the response; a parser
  // that reads them as a body has swallowed the first thing the client sent.
  const bytes = enc.encode("HTTP/1.1 200 Connection Established\r\nContent-Length: 5\r\n\r\nhello");

  const connect = wac(bytes, "CONNECT", false);
  if (connect.outcome !== "ok") throw new Error(`CONNECT: got ${connect.outcome}`);
  if (connect.body !== "") throw new Error(`CONNECT: body ${JSON.stringify(connect.body)}, want none`);
  if (connect.consumed !== bytes.length - 5) {
    throw new Error(`CONNECT: consumed ${connect.consumed}, want ${bytes.length - 5} — the tunnel's bytes are not ours`);
  }

  // The same response to a GET *does* have a body, which is what makes the rule about the
  // method rather than about the status.
  const get = wac(bytes, "GET", false);
  if (get.outcome !== "ok" || get.body !== "hello") {
    throw new Error(`GET: ${get.outcome} body ${JSON.stringify((get as { body?: string }).body)}, want "hello"`);
  }

  // A non-2xx to CONNECT is an ordinary response and keeps its body.
  const refused = wac(enc.encode("HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\n\r\nno"), "CONNECT", false);
  if (refused.outcome !== "ok" || refused.body !== "no") {
    throw new Error(`403 to CONNECT: body ${JSON.stringify((refused as { body?: string }).body)}, want "no"`);
  }
});
