import { wacBind } from "./harness/wacBind.ts";
try { await wacBind("packages/sh/src/sh.wac"); console.log("sh.wac ok"); }
catch (e) { console.log(String(e).split("\n").slice(0,8).join("\n")); }
