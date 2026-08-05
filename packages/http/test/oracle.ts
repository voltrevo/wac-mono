// Drive Node's HTTP parser as the oracle.
//
// Node parses with llhttp, which is the most exercised HTTP/1.1 parser there is, and it is a real
// parser rather than a reference reimplementation — so agreeing with it is evidence about the
// wire, not about my reading of the RFC. `oracle_node.mjs` starts a loopback server, feeds each
// case in on its own connection, and reports what came out.
//
// One artifact of driving a real server rather than a parser in isolation: Node does not dispatch
// an HTTP/1.1 request with no `Host` header, so such a case reads as "incomplete" whatever the
// parser thought. Test cases therefore carry a `Host` unless the absence is the point.
//
// The three outcomes are kept apart deliberately. "Needs more bytes" is not "rejected": a parser
// that conflates them either hangs up on slow clients or accepts truncated messages, and both are
// bugs this suite is meant to find.

export type Outcome =
  | { outcome: "ok"; method: string; target: string; version: string; rawHeaders: string[]; body: string; trailers: string[] }
  | { outcome: "error"; code: string }
  | { outcome: "incomplete" };

/** Parse every case with Node. One subprocess for the whole batch. */
export async function oracle(cases: Uint8Array[], nudgeMs?: number): Promise<Outcome[]> {
  if (cases.length === 0) return [];
  const payload = JSON.stringify(cases.map(toBase64));
  const command = new Deno.Command("node", {
    args: ["packages/http/test/oracle_node.mjs"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    // Passed through so a test can shrink the oracle's hurry-up window to nothing — see
    // `oracle_clock.test.ts`, which is 0082's regression test.
    env: nudgeMs === undefined ? {} : { WAC_HTTP_ORACLE_NUDGE_MS: String(nudgeMs) },
    clearEnv: false,
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(payload));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(`the oracle failed: ${new TextDecoder().decode(stderr)}`);
  }
  const outcomes = JSON.parse(new TextDecoder().decode(stdout)) as Outcome[];
  // `timeout` is the oracle's backstop firing, which means a case hung rather than that llhttp had an
  // opinion. Throwing here is deliberate: the alternative is a mismatch that reads like a parser
  // disagreement, which is what 0082 was — a clock's answer wearing a verdict's clothes.
  const hung = outcomes.filter((o) => (o as { outcome: string }).outcome === "timeout").length;
  if (hung > 0) {
    throw new Error(
      `the oracle's backstop fired on ${hung} of ${cases.length} cases: llhttp never decided and the ` +
        `connection never closed. That is a hang in the oracle, not a parser disagreement.`,
    );
  }
  return outcomes;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Bytes from a string with `\r\n` written out, since that is how HTTP is actually read. */
export function wire(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
