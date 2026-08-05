// wacVersion — check the sibling wac checkout is new enough, and say so when it is not.
//
// `deno.json` maps `wac/` to `../wac/atoms/wac/`, so the compiler is whatever the reader
// happens to have checked out. When that is older than a feature a package uses, the
// failure lands in the package — `CompileError: f64.add[0] expected type f64` in gzip,
// or a type error in crypto — and names nothing about compilers. That has cost three
// agents time on four separate occasions [issues 0001, 0008].
//
// So: `wac-version.json` records the oldest compiler this repo works with, and the first
// `wacBind` of a run checks it. A checkout at or after the pin passes silently. An older
// one fails with the one sentence that would have saved each of those afternoons.
//
// **The pin is a minimum, not an exact version.** Being ahead of it is the normal state
// and is never an error — but drifting a long way ahead means the pin has stopped
// describing anything, so a run that is far ahead prints a nudge to bump it.

const NUDGE_AFTER = 40; // commits ahead before suggesting the pin is stale

type Pin = { commit: string; shortCommit: string; reason: string; updated: string };

let checked = false;

/** Where the sibling checkout is, derived from the import map rather than hardcoded. */
function wacRoot(): string | null {
  try {
    const url = import.meta.resolve("wac/wacCompile.ts");
    if (!url.startsWith("file://")) return null;
    const path = decodeURIComponent(new URL(url).pathname);
    const marker = "/atoms/wac/";
    const i = path.lastIndexOf(marker);
    return i < 0 ? null : path.slice(0, i);
  } catch {
    return null;
  }
}

function git(root: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = new Deno.Command("git", { args: ["-C", root, ...args], stdout: "piped", stderr: "null" })
      .outputSync();
    return { ok: r.success, out: new TextDecoder().decode(r.stdout).trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

/**
 * Verify the compiler checkout, once per process.
 *
 * Throws when it is demonstrably too old. Stays quiet when the question cannot be
 * answered — no git, no repo, a vendored copy — because a check that cannot run is not
 * evidence of a problem, and turning someone's unusual setup into a hard failure would
 * make this the thing that costs the afternoon.
 */
export function checkWacVersion(): void {
  if (checked) return;
  checked = true;

  let pin: Pin;
  try {
    pin = JSON.parse(Deno.readTextFileSync(new URL("../wac-version.json", import.meta.url)));
  } catch {
    return; // no pin recorded; nothing to check against
  }

  const root = wacRoot();
  if (root === null) return;
  if (!git(root, ["rev-parse", "--git-dir"]).ok) return;

  // `merge-base --is-ancestor` answers the question that matters — "does this checkout
  // contain the pinned commit" — rather than "is it the same commit", which would make
  // every wac push a wac-mono failure.
  const contains = git(root, ["merge-base", "--is-ancestor", pin.commit, "HEAD"]);
  if (!contains.ok) {
    const head = git(root, ["rev-parse", "--short", "HEAD"]).out || "unknown";
    const known = git(root, ["cat-file", "-e", `${pin.commit}^{commit}`]).ok;
    throw new Error(
      `wac-mono needs a newer compiler.\n` +
      `  expected: wac at or after ${pin.shortCommit} — ${pin.reason}\n` +
      `  found:    ${head} in ${root}\n` +
      (known
        ? `  fix:      git -C ${root} merge origin/master   (the commit exists there but is not in HEAD)\n`
        : `  fix:      git -C ${root} pull\n`) +
      `  (pin recorded in wac-version.json, ${pin.updated})`,
    );
  }

  const ahead = Number(git(root, ["rev-list", "--count", `${pin.commit}..HEAD`]).out || "0");
  // Days as well as commits, because the policy is about *staleness* and commits are a poor proxy
  // for it: fifty-two of them landed in two days here, and a quiet week can pass with none. The
  // rule is to bump the pin whenever the suite has passed and wac has moved (README, "Keeping the
  // compiler pin current"), so the note names both numbers and the exact command.
  const days = Math.floor((Date.now() - Date.parse(pin.updated)) / 86_400_000);
  if (ahead >= NUDGE_AFTER) {
    console.warn(
      `note: wac is ${ahead} commits ahead of the pin (${pin.shortCommit}, ${pin.updated}` +
      `${Number.isFinite(days) ? `, ${days} day${days === 1 ? "" : "s"} ago` : ""}). ` +
      `If this run passes, \`deno task wac:pin -- "routine"\` records today's compiler.`,
    );
  }
}
