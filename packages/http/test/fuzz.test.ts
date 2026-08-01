// Mutated HTTP messages, checked against llhttp for the one property that matters.
//
// The property is not "the same answer". It is **neither parser accepts what the other refuses**.
// That is the condition request smuggling needs: a front-end and a back-end that disagree about
// whether a byte string is a message, or about where it ends, let an attacker write one request
// that the two read differently. Two independent parsers agreeing on acceptance over a large
// mutated corpus is real evidence about that, in a way that agreeing on error codes would not be.
//
// Mutations are applied to valid messages rather than generating bytes at random, because a
// random string is refused by both parsers immediately and tests nothing. The interesting inputs
// are one edit away from valid.

import { wacBind } from "../../../harness/wacBind.ts";
import { oracle, wire } from "./oracle.ts";

const mod = await wacBind("packages/http/test/probe.wac") as unknown as {
  parse(input: Uint8Array, maxBody: number): Uint8Array;
};

const dec = new TextDecoder();
const MAX_BODY = 1 << 20;

function wacParse(input: Uint8Array): {
  outcome: "ok" | "bad" | "incomplete";
  consumed: number;
  method: string;
  minor: number;
  headers: string[];
} {
  const parts = dec.decode(mod.parse(input, MAX_BODY)).split("\0");
  if (parts[0] !== "ok") {
    return {
      outcome: parts[0] === "bad" ? "bad" : "incomplete",
      consumed: 0,
      method: "",
      minor: -1,
      headers: [],
    };
  }
  const headers: string[] = [];
  for (let i = 6; i + 1 < parts.length; i += 2) headers.push(parts[i].toLowerCase());
  return {
    outcome: "ok",
    consumed: Number(parts[4]),
    method: parts[1],
    minor: Number(parts[3]),
    headers,
  };
}

/**
 * Methods llhttp knows. It has a closed table; RFC 9110 §9 says a method is any token and a
 * server answers 501 for one it does not implement — a semantic answer, not a parse failure.
 *
 * So this parser is deliberately more permissive here, and the fuzzer has to know that or it
 * would report every mutated method as a disagreement. Unlike the framing rules, an unrecognised
 * method cannot change where a message ends, so the permissiveness costs nothing.
 */
const KNOWN_METHODS = new Set([
  "DELETE", "GET", "HEAD", "POST", "PUT", "CONNECT", "OPTIONS", "TRACE", "COPY", "LOCK",
  "MKCOL", "MOVE", "PROPFIND", "PROPPATCH", "SEARCH", "UNLOCK", "BIND", "REBIND", "UNBIND",
  "ACL", "REPORT", "MKACTIVITY", "CHECKOUT", "MERGE", "M-SEARCH", "NOTIFY", "SUBSCRIBE",
  "UNSUBSCRIBE", "PATCH", "PURGE", "MKCALENDAR", "LINK", "UNLINK", "SOURCE", "QUERY",
]);

const SEEDS = [
  "GET / HTTP/1.1\r\nHost: a\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\nhello",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
  "GET /a?b=c HTTP/1.1\r\nHost: a\r\nAccept: */*\r\nCookie: k=v\r\n\r\n",
  "PUT /p HTTP/1.0\r\nHost: a\r\nContent-Length: 3\r\n\r\nabc",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-T: v\r\n\r\n",
];

/** Bytes worth inserting: the ones that change a message's shape rather than its content. */
const INTERESTING = [13, 10, 0x20, 9, 0, 0x3a, 0x2c, 0x3b, 0x7f, 0x80, 0xff, 0x2e, 0x2d];

/** Header lines that create or resolve a framing ambiguity. */
const INJECTIONS = [
  "Content-Length: 5\r\n",
  "Content-Length: 0\r\n",
  "Content-Length: +5\r\n",
  "Content-Length:\r\n",
  "Transfer-Encoding: chunked\r\n",
  "Transfer-Encoding: gzip, chunked\r\n",
  "Transfer-Encoding: chunked, gzip\r\n",
  "Transfer-Encoding : chunked\r\n",
  "X: 1\r\n 2\r\n",
  "X:\r\n\tY: 2\r\n",
  " Host: b\r\n",
  "Host : b\r\n",
  "\r\n",
];

function makeRng(seed: number): () => number {
  let x = seed | 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
}

function mutate(next: () => number, seed: string): Uint8Array {
  const base = Array.from(wire(seed));
  const kind = next() % 6;
  if (kind === 0) {
    // Insert an interesting byte somewhere.
    const at = next() % (base.length + 1);
    base.splice(at, 0, INTERESTING[next() % INTERESTING.length]);
  } else if (kind === 1) {
    if (base.length > 0) base.splice(next() % base.length, 1);
  } else if (kind === 2) {
    if (base.length > 0) base[next() % base.length] = INTERESTING[next() % INTERESTING.length];
  } else if (kind === 3) {
    // Truncate, which should produce "incomplete" far more often than "bad".
    base.length = next() % (base.length + 1);
  } else if (kind === 4) {
    // Splice in a header line just after the request line, where framing decisions are made.
    const text = INJECTIONS[next() % INJECTIONS.length];
    const crlf = seed.indexOf("\r\n") + 2;
    base.splice(crlf, 0, ...Array.from(wire(text)));
  } else {
    // Duplicate an existing line, which is how a second Content-Length appears in the wild.
    const lines = seed.split("\r\n");
    const pick = 1 + (next() % Math.max(1, lines.length - 1));
    const line = lines[pick] ?? "";
    const at = seed.indexOf("\r\n") + 2;
    base.splice(at, 0, ...Array.from(wire(line + "\r\n")));
  }
  return new Uint8Array(base);
}

async function sweep(seedValue: number, rounds: number): Promise<void> {
  const next = makeRng(seedValue);
  const cases: Uint8Array[] = [];
  for (let i = 0; i < rounds; i++) {
    let bytes = wire(SEEDS[next() % SEEDS.length]);
    // One case in five is left alone. Random edits almost always break a message, so without
    // this the corpus is nearly all rejections — and a corpus of rejections agrees trivially,
    // which is what the guard below is there to notice.
    const edits = next() % 5 === 0 ? 0 : 1 + (next() % 3);
    for (let e = 0; e < edits; e++) bytes = mutate(next, dec.decode(bytes));
    cases.push(bytes);
  }

  const want = await oracle(cases);
  const bad: string[] = [];
  const counts = { ok: 0, error: 0, incomplete: 0 };
  const skipped = { pipelined: 0, noHost: 0, http09: 0, unknownMethod: 0 };
  let compared = 0;
  for (let i = 0; i < cases.length; i++) {
    const parsed = wacParse(cases[i]);
    const got = parsed.outcome;
    const consumed = parsed.consumed;
    const o = want[i];

    // The oracle is a *server*: it reads the whole stream and reports the first thing that went
    // wrong anywhere in it. This parser reports one message and says where it ended. When bytes
    // are left over, the two are answering different questions — llhttp's error may be about a
    // second, mangled message this parser never claimed. Skipped, and counted.
    if (got === "ok" && consumed < cases[i].length) {
      skipped.pipelined++;
      continue;
    }
    // Node's *server* will not dispatch an HTTP/1.1 request with no Host, so the oracle reports
    // "incomplete" whatever its parser decided. An artifact of driving a server rather than a
    // parser, not a difference of opinion.
    if (got === "ok" && parsed.minor === 1 && !parsed.headers.includes("host")) {
      skipped.noHost++;
      continue;
    }
    // llhttp accepts an HTTP/0.9 request line; this refuses one, on the grounds that a 0.9
    // request has no headers and no way to frame a body. Listed in http.test.ts too.
    if (o.outcome === "ok" && o.version === "0.9") {
      skipped.http09++;
      continue;
    }
    // A method llhttp does not know. See KNOWN_METHODS.
    if (got === "ok" && !KNOWN_METHODS.has(parsed.method) && o.outcome !== "ok") {
      skipped.unknownMethod++;
      continue;
    }
    compared++;
    counts[o.outcome === "ok" ? "ok" : o.outcome === "error" ? "error" : "incomplete"]++;
    const label = JSON.stringify(dec.decode(cases[i])).replaceAll("\\r\\n", "|").slice(0, 90);

    // The one property. Everything else — which error, how far along — is unspecified.
    if (o.outcome === "ok" && got !== "ok") {
      bad.push(`${label}: llhttp accepted, wac said ${got}`);
    }
    if (o.outcome !== "ok" && got === "ok") {
      bad.push(`${label}: llhttp said ${o.outcome}, wac accepted`);
    }
  }
  if (bad.length > 0) {
    throw new Error(`seed ${seedValue}: ${bad.length}/${cases.length} disagreed on acceptance:\n  ${bad.slice(0, 12).join("\n  ")}`);
  }
  // Two guards, because a sweep that compares nothing passes. `compared` is how many cases
  // reached the comparison at all; `counts.ok` is how many of those were messages llhttp
  // accepted — a corpus of nothing but rejections would agree trivially.
  if (compared < rounds * 0.5) {
    throw new Error(
      `seed ${seedValue}: only ${compared}/${rounds} cases were compared, the rest skipped as ` +
      `known differences ${JSON.stringify(skipped)}`,
    );
  }
  if (counts.ok < compared * 0.05) {
    throw new Error(
      `seed ${seedValue}: of ${compared} compared, only ${counts.ok} were accepted by llhttp — ` +
      `a corpus of rejections agrees trivially`,
    );
  }
  // Every skip is a known, named difference. Counted together, because a change that pushed most
  // cases into one of these buckets would leave the sweep green while comparing almost nothing.

}

Deno.test("fuzz: neither parser accepts what the other refuses", async () => {
  await sweep(0x1234abcd, 250);
});

Deno.test("fuzz: a second seed", async () => {
  await sweep(0x5150cafe, 250);
});
