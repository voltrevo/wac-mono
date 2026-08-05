// The oracle's answer must not depend on how fast the machine is.
//
// wac-mono 0082: four of five flaky tests were this file's oracle deciding "the parser wants more bytes"
// because llhttp had not spoken within 60 ms. On a loaded machine a *complete* request misses that
// window, is reported as incomplete, and the differential fails with "llhttp wanted more bytes, wac
// accepted" — against whatever change happened to be in the tree. I spent the first minutes of my own
// diagnosis wondering what I had broken in `packages/http`, having touched nothing in it.
//
// The window is still there, because without it some shapes leave node's server holding a half-closed
// socket until one of its own timeouts and the file takes forty seconds instead of three. What changed is
// that the window no longer *decides*: when it fires, the connection is half-closed and llhttp is asked.
//
// This pins that. Run the same cases with the window at 60 ms and at **zero**, and the outcomes must be
// identical — because a machine so slow that the window never helps is the same machine as one where the
// window is switched off, and that is the condition under which the suite went red.

import { oracle } from "./oracle.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const enc = new TextEncoder();
const wire = (s: string) => enc.encode(s);

/** One of each outcome, and the shapes that were misreported: a body, a chunked body, a bare prefix. */
const CASES = [
  // Complete — these are the ones a slow window turned into "incomplete".
  "GET / HTTP/1.1\r\nHost: a\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\nhello",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n2\r\nbc\r\n0\r\n\r\n",
  // Genuinely incomplete — the outcome the window used to be *for*.
  "GET / HTTP/1.1\r\nHost:",
  "POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\nhel",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel",
  // Malformed — must stay an error rather than becoming either of the above.
  "GET / HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\nhello",
  "POST /x HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\nz\r\n\r\n",
].map(wire);

Deno.test("the oracle answers the same with no hurry-up window as with one", async () => {
  const hurried = await oracle(CASES);
  const patient = await oracle(CASES, 0);

  assertEquals(hurried.length, CASES.length);
  assertEquals(patient.length, CASES.length);
  for (let i = 0; i < CASES.length; i++) {
    // The outcome is the load-sensitive part; the parsed detail follows from it.
    assertEquals(
      patient[i].outcome,
      hurried[i].outcome,
      `case ${i} (${JSON.stringify(new TextDecoder().decode(CASES[i]))}) changed answer when the ` +
        `window was removed — the clock is still deciding`,
    );
  }

  // And the three outcomes are all actually present, or this test would pass while measuring one path.
  const kinds = new Set(hurried.map((o) => o.outcome));
  assertEquals(kinds.has("ok"), true, "no complete case in the batch");
  assertEquals(kinds.has("incomplete"), true, "no incomplete case in the batch");
  assertEquals(kinds.has("error"), true, "no malformed case in the batch");
});
