// The oracle's batching, which its answers now depend on.
//
// `oracle_node.mjs` runs its cases **concurrently** — thirty-two in flight — because an incomplete
// message is only ever resolved by `CASE_TIMEOUT_MS` expiring, so a test made of nothing but
// incomplete cases paid that window once per case in series. `http.test.ts`'s two prefix tests are
// exactly that shape and were 3s and 4s between them; the whole package was 13s and is 3s.
//
// What that costs is a new dependence on something the file already had to get right: a result is
// correlated by the **client's port**, not by a running index, because llhttp's `clientError` for one
// case can arrive after the next connection has opened. That was a latent hazard when the cases were
// sequential — the comment in `oracle_node.mjs` says it showed up as valid requests reported as
// errors — and with thirty-two connections open at once it is load-bearing.
//
// So this asserts the property directly: a single batch mixing all three outcomes, interleaved, each
// case distinguishable from every other. Misattribution cannot hide in it — swapping any two results
// changes the answer for both.

import { oracle, wire } from "./oracle.ts";

function eq<T>(got: T, want: T, msg: string): void {
  if (got !== want) throw new Error(`${msg}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
}

Deno.test("oracle: a batch mixing all three outcomes keeps each answer with its own case", async () => {
  // Interleaved deliberately, so a result recorded against a neighbour is visible whichever
  // direction it slipped.
  const cases: Array<[string, "ok" | "error" | "incomplete", string]> = [
    ["GET /one HTTP/1.1\r\nHost: a\r\n\r\n", "ok", "/one"],
    ["GET /x HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\nhe", "incomplete", ""],
    ["GET /two HTTP/1.1\r\nHost: a\r\n\r\n", "ok", "/two"],
    ["GET / HTTP/1.1\r\nHost: a\r\nContent-Length: x\r\n\r\n", "error", ""],
    ["GET /three HTTP/1.1\r\nHost: a\r\n\r\n", "ok", "/three"],
    ["POST /y HTTP/1.1\r\nHost: a\r\nContent-Length: 9\r\n\r\nshort", "incomplete", ""],
    ["GET /four HTTP/1.1\r\nHost: a\r\n\r\n", "ok", "/four"],
  ];

  // Repeated past the concurrency bound, so the batching is exercised across batch boundaries as
  // well as within one: a case in batch two attributed to batch one would be caught here and not by
  // a seven-case run.
  const many: typeof cases = [];
  for (let rep = 0; rep < 8; rep++) many.push(...cases);

  const got = await oracle(many.map(([text]) => wire(text)));
  eq(got.length, many.length, "one answer per case");

  for (let i = 0; i < many.length; i++) {
    const [text, outcome, target] = many[i];
    const g = got[i];                       // bound, so the outcome check narrows it
    eq(g.outcome, outcome, `case ${i} (${JSON.stringify(text.slice(0, 32))})`);
    if (g.outcome === "ok") {
      // The target is what distinguishes the accepted cases from one another, so this is the
      // assertion that a swap between two `ok` results cannot survive.
      eq(g.target, target, `case ${i}'s target came from another case`);
    }
  }
});
