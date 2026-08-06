// Every `[flaky NNNN]` tag names an issue that is still open.
//
// A test that fails for reasons unrelated to the change under test costs whoever is pushing an hour of
// diagnosing their own work — that is what wac-mono 0082 is about, and it is why the three tests it
// covers carry the tag in their *name*: a failure then arrives with its own alternative explanation
// rather than needing one looked up.
//
// **The tag is the dangerous half.** "Known flaky" is how a real regression gets waved through, and a tag
// that outlives its issue is exactly that — an explanation standing by for a failure it no longer
// explains. So this asserts the tag and the issue rise and fall together: the moment `issues/open/0082…`
// moves to `closed/`, this test fails and says which names to take off. That is the pressure in the right
// direction, since the alternative — a label nobody removes — is the usual end of this practice.

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/** `[flaky 0082]` in a test name, wherever it appears. */
const TAG = /\[flaky (\d{4})\]/g;

type Tagged = { file: string; line: number; issue: string; name: string };

async function taggedTests(): Promise<Tagged[]> {
  const out: Tagged[] = [];
  const walk = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === ".cache") continue;
        await walk(path);
      } else if (e.name.endsWith(".ts")) {
        const text = await Deno.readTextFile(path);
        if (!text.includes("[flaky ")) continue;
        text.split("\n").forEach((line, i) => {
          // The declaration, not the prose: a comment explaining the tag is expected and must not be
          // mistaken for one. `Deno.test("[flaky …` and `name: "[flaky …` are the two spellings.
          if (!/(Deno\.test\(|name:\s*)"\[flaky /.test(line)) return;
          for (const m of line.matchAll(TAG)) {
            out.push({ file: path, line: i + 1, issue: m[1], name: line.trim() });
          }
        });
      }
    }
  };
  for (const root of ["packages", "harness", "tools"]) await walk(root);
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
};

/** `issues/open/NNNN-*.md`, or null when no such open issue exists. */
async function openIssue(number: string): Promise<string | null> {
  for await (const e of Deno.readDir("issues/open")) {
    if (e.isFile && e.name.startsWith(`${number}-`)) return `issues/open/${e.name}`;
  }
  return null;
}

Deno.test("every [flaky NNNN] tag names an issue that is still open", async () => {
  const tagged = await taggedTests();
  const wrong: string[] = [];
  for (const t of tagged) {
    const open = await openIssue(t.issue);
    if (open !== null) continue;
    const closed = [...Deno.readDirSync("issues/closed")].some((e) => e.name.startsWith(`${t.issue}-`));
    wrong.push(
      `${t.file}:${t.line} is tagged [flaky ${t.issue}], which is ${
        closed ? "closed" : "not an issue at all"
      }.\n    ${t.name}`,
    );
  }
  assertEquals(
    wrong.join("\n  "),
    "",
    `${wrong.length} tag(s) outlived their issue. Take the tag off the test name — a "known flaky" ` +
      `label with nothing behind it is how a real regression gets waved through:\n  ${wrong.join("\n  ")}`,
  );
  // Printed rather than merely checked, so a reader of a green run knows what is being tolerated. A
  // list nobody sees is how three flaky tests became normal in the first place.
  if (tagged.length > 0) {
    console.log(`  tolerating ${tagged.length} known-flaky test(s):`);
    for (const t of tagged) console.log(`    ${t.file}:${t.line} — issue ${t.issue}`);
  }
});

Deno.test("the issue a tag names says what the tag is for", async () => {
  // A tag pointing at an issue that never mentions flakiness would be a dead end for the person reading
  // it mid-failure — which is the one moment this whole convention exists to serve.
  for (const t of await taggedTests()) {
    const path = await openIssue(t.issue);
    if (path === null) continue;   // the test above is the one that reports this
    const text = (await Deno.readTextFile(path)).toLowerCase();
    assertEquals(
      text.includes("flak") || text.includes("fail, rather than slow down") ||
        text.includes("intermittent"),
      true,
      `${path} does not read as an issue about intermittent failure, but ${t.file}:${t.line} points at it`,
    );
  }
});

Deno.test("the convention is written down where somebody would look for it", async () => {
  // In `issues/README.md`, because that is what a person opens when a test name tells them to read an
  // issue number. A convention that lives only in the tests that use it is one the next person invents
  // differently.
  assertEquals(await exists("issues/README.md"), true, "issues/README.md is missing");
  const readme = await Deno.readTextFile("issues/README.md");
  assertEquals(
    readme.includes("[flaky"),
    true,
    "issues/README.md does not describe the [flaky NNNN] tag, so the convention is only in the code",
  );
});
