// The website's terminal shows a transcript. This runs it.
//
//   deno test -A tools/frontpage.test.ts
//
// wac's front page prints a shell session — `seq 1 20 | grep 7 | wc -l`, and what it answers. That
// output is hardcoded there, because a page cannot boot a shell to render itself. Hardcoded output
// on a page that argues for checking things is exactly the sort of claim that rots, so it is
// checked here instead: the same commands, through `packages/box/example/boxsh.wac`, which is the
// command-line twin of the terminal the site embeds.
//
// The site lives in the sibling `wac` checkout. Without one there is nothing to check, and the test
// says so rather than passing quietly — a silent skip reads as coverage that was never there.

import { appRunner } from "../harness/appRun.ts";

const SITE = new URL("../../wac/src/next/Home.tsx", import.meta.url).pathname;

/** The `TRANSCRIPT` table on the front page: each command and the output printed beneath it. */
function parseTranscript(src: string): [string, string][] {
  const block = src.match(/export const TRANSCRIPT: \[string, string\]\[\] = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error("Home.tsx has no TRANSCRIPT table — has it been renamed?");
  const rows: [string, string][] = [];
  for (const m of block[1].matchAll(/\["((?:[^"\\]|\\.)*)", "((?:[^"\\]|\\.)*)"\]/g)) {
    const unescape = (s: string) => s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    rows.push([unescape(m[1]), unescape(m[2])]);
  }
  return rows;
}

Deno.test("the website's shell transcript is what the shell actually prints", async () => {
  let src: string;
  try {
    src = await Deno.readTextFile(SITE);
  } catch {
    throw new Error(
      `no wac checkout at ${SITE} — clone it beside this repo, or run this test where one is. ` +
        `Skipping silently would report coverage that does not exist.`,
    );
  }

  const rows = parseTranscript(src);
  if (rows.length < 2) throw new Error(`only ${rows.length} transcript rows found`);

  // One shell for all of them: a session, like the page shows, and one process rather than N.
  const sh = await appRunner("packages/box/example/boxsh.wac", { read: true, write: true });
  const wrong: string[] = [];
  for (const [command, expected] of rows) {
    const r = await sh.run(["-c", command], {});
    const got = r.out.replace(/\n+$/, "");
    if (got !== expected) {
      wrong.push(`${command}\n      page says: ${JSON.stringify(expected)}\n      shell says: ${JSON.stringify(got)}`);
    }
  }
  if (wrong.length) {
    throw new Error(`${wrong.length} of ${rows.length} transcript lines are wrong:\n  ${wrong.join("\n  ")}`);
  }
});
