// Run the exact commands the front page prints, through the real shell, and show what comes back.
import { appRunner } from "./harness/appRun.ts";

const GRANTS = { read: true, write: true };
const sh = await appRunner("packages/sh/src/sh.wac", GRANTS);

const script = [
  `seq 1 20 | grep 7 | wc -l`,
  `mkdir -p /tmp/wacsite && echo 'a whole new stack' > /tmp/wacsite/note`,
  `gzip -c /tmp/wacsite/note | wc -c`,
  `sha256sum < /tmp/wacsite/note | cut -c1-16`,
].join("\n");

const r = await sh.run(["-c", script], {});
console.log("=== exit", r.status, "===");
console.log(r.out);
if (r.err) console.log("--- stderr ---\n" + r.err);
