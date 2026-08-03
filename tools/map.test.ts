// MAP.md is generated, so the only way it stays true is for the suite to say when it is not.
//
// A document that drifts is worse than no document: you check it against the tree anyway, and
// then it was costing you time rather than saving it. This is the same bargain as
// `wac-version.json` — a machine-checked claim rather than a promise someone made once.

Deno.test("MAP.md is current — run `deno task map`", async () => {
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "tools/map.ts", "--check"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (r.code !== 0) {
    throw new Error(new TextDecoder().decode(r.stderr).trim() || "map --check failed");
  }
});
