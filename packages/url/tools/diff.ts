// Print wac's parse of one input beside the host's. The development loop for this package.
//
//   deno run -A packages/url/tools/diff.ts 'http://a/b?c#d'
//   deno run -A packages/url/tools/diff.ts '../x' 'http://a/b/c'

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/url/test/probe.wac") as unknown as {
  parse(input: Uint8Array): Uint8Array;
  parseWithBase(input: Uint8Array, base: Uint8Array): Uint8Array;
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const input = Deno.args[0] ?? "";
const base = Deno.args[1];

const raw = base === undefined
  ? mod.parse(enc.encode(input))
  : mod.parseWithBase(enc.encode(input), enc.encode(base));
const got = dec.decode(raw).split("\0");

const FIELDS = ["ok", "href", "protocol", "username", "password", "hostname", "port", "pathname", "search", "hash"];

let want: string[];
try {
  const u = base === undefined ? new URL(input) : new URL(input, base);
  want = ["1", u.href, u.protocol.slice(0, -1), u.username, u.password, u.hostname, u.port, u.pathname, u.search, u.hash];
} catch {
  want = ["0"];
}

for (let i = 0; i < FIELDS.length; i++) {
  const g = got[i];
  const w = want[i];
  if (g === undefined && w === undefined) continue;
  const mark = g === w ? "  " : "->";
  console.log(`${mark} ${FIELDS[i].padEnd(9)} wac ${JSON.stringify(g)}  host ${JSON.stringify(w)}`);
}
