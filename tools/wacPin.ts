// Record the sibling wac checkout's HEAD as the minimum this repo needs.
//
//   deno task wac:pin  [-- "why this compiler is needed"]
//
// Run it *after* the suite passes against that compiler, not before: the pin is a claim
// that this repo works with it, and a claim nobody checked is worse than no claim.
// See "Keeping the compiler pin current" in README.md.

const root = (() => {
  const url = import.meta.resolve("wac/wacCompile.ts");
  const path = decodeURIComponent(new URL(url).pathname);
  return path.slice(0, path.lastIndexOf("/atoms/wac/"));
})();

const git = (args: string[]): string => {
  const r = new Deno.Command("git", { args: ["-C", root, ...args], stdout: "piped" }).outputSync();
  if (!r.success) throw new Error(`git ${args.join(" ")} failed in ${root}`);
  return new TextDecoder().decode(r.stdout).trim();
};

const dirty = git(["status", "--porcelain"]).length > 0;
if (dirty) {
  console.error(
    `refusing: ${root} has uncommitted changes.\n` +
    `A pin naming a commit is a lie if the working tree differs from it.`,
  );
  Deno.exit(1);
}

const commit = git(["rev-parse", "HEAD"]);
const short = git(["rev-parse", "--short", "HEAD"]);
const subject = git(["log", "-1", "--format=%s"]);

const pinPath = new URL("../wac-version.json", import.meta.url);
const pin = JSON.parse(await Deno.readTextFile(pinPath));

if (pin.commit === commit) {
  console.log(`already pinned to ${short} — nothing to do`);
  Deno.exit(0);
}

const behind = Number(
  new TextDecoder().decode(
    new Deno.Command("git", {
      args: ["-C", root, "rev-list", "--count", `${commit}..${pin.commit}`],
      stdout: "piped",
      stderr: "null",
    }).outputSync().stdout,
  ).trim() || "0",
);
if (behind > 0) {
  console.error(
    `refusing: HEAD (${short}) does not contain the current pin ${pin.shortCommit}.\n` +
    `That would move the minimum *backwards*. Pull wac first.`,
  );
  Deno.exit(1);
}

// A merge commit's subject says nothing about why the compiler is needed, and that is
// the one field a reader of the failure message actually uses.
const given = Deno.args.join(" ").trim();
if (!given) {
  console.warn(
    `note: no reason given, using the commit subject — "${subject}".\n` +
    `      \`deno task wac:pin -- "generic enums, for packages/std"\` reads better in a\n` +
    `      failure message six weeks from now.`,
  );
}
const reason = given || subject;
const updated = new Date().toISOString().slice(0, 10);
pin.commit = commit;
pin.shortCommit = short;
pin.reason = reason;
pin.updated = updated;
await Deno.writeTextFile(pinPath, JSON.stringify(pin, null, 2) + "\n");

console.log(`pinned wac to ${short} (${updated})\n  reason: ${reason}`);
console.log(`\nRun the suite before committing this — the pin claims the repo works with it.`);
