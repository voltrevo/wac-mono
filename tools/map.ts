// Generate MAP.md: every package, what it is, how big it is, what depends on what, and every
// program you can actually build and run.
//
//   deno task map          # rewrite MAP.md
//   deno task map -- --check   # fail if it is out of date
//
// Generated rather than written because a hand-kept inventory of two dozen packages is wrong
// within a day, and a bird's-eye view nobody trusts is worse than none — you check it against
// the tree anyway, and then why did you read it. Everything here comes from the source: the
// summary is each package's own README, the sizes are line counts, the dependencies are the
// relative imports, and the runnable list is every `main` or `page` export there is.
//
// `--check` is what keeps it honest. It runs in the suite, so adding a package and forgetting
// the map is a failing test rather than a stale document nobody notices.

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

type Package = {
  name: string;
  summary: string;
  wacLines: number;
  hostTests: number;
  wacTests: number;
  /** Sibling packages this one imports, by relative path. */
  uses: string[];
  /** Entry points: `export i32 main(...)` or `export i32 page(...)`. */
  programs: { path: string; kind: "cli" | "page"; blurb: string }[];
};

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const at = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(at);
    else yield at;
  }
}

async function read(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

/**
 * The first sentence of a package README, which by convention is what the package *is*.
 *
 * One sentence rather than the paragraph: the table has to stay readable at two dozen rows,
 * and every one of these READMEs opens with a sentence that would serve as its epitaph.
 */
function summarize(readme: string): string {
  const body = readme.split("\n").slice(1).join("\n").trim();
  const para = body.split("\n\n")[0].replace(/\n/g, " ").trim();
  // The first sentence: a full stop followed by space, end, or the close of an emphasis —
  // `**…done.**` is a sentence too, and without that case `ssh`'s row ran to four lines.
  const stop = para.search(/\.(\s|$|\*)/);
  let first = (stop < 0 ? para : para.slice(0, stop + 1)).trim();
  // And a ceiling regardless, because one sentence can still be a paragraph in disguise.
  if (first.length > 150) first = first.slice(0, 147).replace(/\s\S*$/, "") + "…";
  return first.replace(/\|/g, "\\|");
}

/**
 * A program's own first line of comment, which is what it does.
 *
 * Every entry point in this repo opens with one, so the list of programs can be a menu rather
 * than a list of paths. A file that does not is left blank rather than guessed at.
 */
function blurbOf(src: string): string {
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (!t.startsWith("//")) return "";
    const text = t.replace(/^\/\/+\s?/, "").trim();
    if (text !== "") return text.replace(/\|/g, "\\|");
  }
  return "";
}

async function survey(name: string): Promise<Package> {
  const dir = `${ROOT}/packages/${name}`;
  const pkg: Package = {
    name,
    summary: summarize(await read(`${dir}/README.md`)),
    wacLines: 0,
    hostTests: 0,
    wacTests: 0,
    uses: [],
    programs: [],
  };
  const uses = new Set<string>();

  for await (const path of walk(dir)) {
    const rel = path.slice(ROOT.length + 1);
    const src = await read(path);
    if (path.endsWith(".wac")) {
      // Imports from `src/` only. Counting test imports as well made the graph cyclic and the
      // ordering meaningless: every package's tests import `wactest`, `wactest` imports `fmt`,
      // and `fmt`'s own tests import `wactest` again. "Builds on" should mean the library needs
      // it, not that its tests do.
      if (!rel.includes("/test/")) {
        for (const m of src.matchAll(/from "[./]*\.\.\/([a-z0-9]+)\/src\//g)) {
          if (m[1] !== name) uses.add(m[1]);
        }
      }
      if (rel.includes("/test/")) {
        pkg.wacTests += [...src.matchAll(/^export string test[A-Za-z0-9_]*\(/gm)].length;
      } else {
        pkg.wacLines += src.split("\n").length;
        const blurb = blurbOf(src);
        if (/^export i32 main\(/m.test(src)) pkg.programs.push({ path: rel, kind: "cli", blurb });
        if (/^export i32 page\(/m.test(src)) pkg.programs.push({ path: rel, kind: "page", blurb });
      }
    } else if (path.endsWith(".test.ts")) {
      pkg.hostTests += [...src.matchAll(/Deno\.test\(/g)].length;
    }
  }
  pkg.uses = [...uses].sort();
  pkg.programs.sort((a, b) => a.path.localeCompare(b.path));
  return pkg;
}

/**
 * Packages in dependency order, so the table reads bottom-up.
 *
 * A plain topological sort, with ties broken by name so the output does not shuffle between
 * runs — which would make `--check` fail for no reason and teach everyone to ignore it.
 */
function layered(all: Package[]): Package[] {
  const byName = new Map(all.map((p) => [p.name, p]));
  const done = new Set<string>();
  const out: Package[] = [];
  while (out.length < all.length) {
    const ready = all
      .filter((p) => !done.has(p.name))
      .filter((p) => p.uses.every((u) => !byName.has(u) || done.has(u)))
      .sort((a, b) => a.name.localeCompare(b.name));
    // A cycle would leave nothing ready; emit the rest rather than looping forever, because a
    // map that says "these are tangled" is more use than a hang.
    const batch = ready.length > 0 ? ready : all.filter((p) => !done.has(p.name));
    for (const p of batch) {
      out.push(p);
      done.add(p.name);
    }
  }
  return out;
}

function render(pkgs: Package[]): string {
  const ordered = layered(pkgs);
  const totals = pkgs.reduce(
    (a, p) => ({
      wac: a.wac + p.wacLines,
      host: a.host + p.hostTests,
      wacT: a.wacT + p.wacTests,
      progs: a.progs + p.programs.length,
    }),
    { wac: 0, host: 0, wacT: 0, progs: 0 },
  );

  const programs = ordered.flatMap((p) => p.programs.map((x) => ({ ...x, pkg: p.name })));
  const cli = programs.filter((p) => p.kind === "cli");
  const pages = programs.filter((p) => p.kind === "page");

  const rows = ordered.map((p) => {
    const uses = p.uses.filter((u) => pkgs.some((q) => q.name === u));
    return `| [\`${p.name}\`](packages/${p.name}/) | ${p.summary} | ${p.wacLines.toLocaleString()} | ` +
      `${p.hostTests + p.wacTests} | ${uses.length === 0 ? "—" : uses.map((u) => `\`${u}\``).join(" ")} |`;
  });

  return `# The map

Every package, what it is, and every program you can build. **Generated — do not edit.**
Run \`deno task map\` after adding a package or an entry point; \`deno task map -- --check\`
runs in the suite, so a stale map is a failing test rather than a document nobody trusts.

${pkgs.length} packages, ${totals.wac.toLocaleString()} lines of wac, ${totals.host + totals.wacT} tests,
${cli.length} command-line programs and ${pages.length} browser pages.

## Packages

In dependency order: nothing here imports anything below it.

| package | what it is | wac lines | tests | builds on |
|---|---|---|---|---|
${rows.join("\n")}

## Programs

Every \`export i32 main\` in the tree. Build one with:

\`\`\`sh
deno task app:build <path> --allow-read -o name && ./name
\`\`\`

Grants are chosen at build time and the shebang of the result states exactly what it may
reach — see \`packages/platform/README.md\`.

| program | what it does |
|---|---|
${cli.map((p) => `| \`${p.path}\` | ${p.blurb} |`).join("\n")}

## Pages

Every \`export i32 page\`: an interactive browser application, built with \`--target browser\`
and served with the two cross-origin isolation headers that \`SharedArrayBuffer\` needs.

\`\`\`sh
deno task app:build <path> --target browser -o page/index.html
box httpd -8080 page -x
\`\`\`

| page | what it does |
|---|---|
${pages.map((p) => `| \`${p.path}\` | ${p.blurb} |`).join("\n")}
`;
}

const names: string[] = [];
for await (const e of Deno.readDir(`${ROOT}/packages`)) {
  if (e.isDirectory) names.push(e.name);
}
const pkgs = await Promise.all(names.sort().map(survey));
const text = render(pkgs);

if (Deno.args.includes("--check")) {
  const have = await read(`${ROOT}/MAP.md`);
  if (have !== text) {
    console.error("MAP.md is out of date — run `deno task map`");
    Deno.exit(1);
  }
  console.log("MAP.md is current");
} else {
  await Deno.writeTextFile(`${ROOT}/MAP.md`, text);
  console.log(`MAP.md: ${pkgs.length} packages`);
}
