// `Cli` and `Core` are constructed positionally, so the field order in `platform.wac` and
// the argument order in `provider.ts` have to agree exactly.
//
// Nothing checks that, and getting it wrong does not fail to compile — it silently wires
// every capability after the mistake to its neighbour. It has cost an hour twice: once
// adding `waitAny`, where three type errors pointed at the capabilities either side of the
// one that moved, and once adding `spawn`, where the symptom was
// `Cannot read properties of undefined (reading 'ref')` from a program that built cleanly.
//
// This reads both files and compares the two lists by name. It is a text comparison, which
// is crude, and it is the only thing standing between an append in one file and an afternoon.

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/** The parameter names of `<Struct> of(...)` in platform.wac, in order. */
function wacOrder(src: string, struct: string): string[] {
  const start = src.indexOf(`  ${struct} of(`);
  if (start < 0) throw new Error(`no ${struct}.of in platform.wac`);
  const head = src.slice(start, src.indexOf(") {", start));
  // Split on commas at depth zero only. A parameter type may contain them —
  // `fn[bool(string, u8[])] writeFile` has one inside two levels of bracket — and a regex
  // that ignored that produced phantom capabilities named `string` and `i32`.
  const list = head.slice(head.indexOf("(") + 1);
  const parts: string[] = [];
  let depth = 0;
  let at = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "[" || c === "(" || c === "<") depth++;
    else if (c === "]" || c === ")" || c === ">") depth--;
    else if (c === "," && depth === 0) {
      parts.push(list.slice(at, i));
      at = i + 1;
    }
  }
  parts.push(list.slice(at));
  // Each part is `<type> <name>`; the name is the trailing identifier.
  return parts
    .map((x) => (x.trim().match(/([A-Za-z_][A-Za-z0-9_]*)$/) ?? ["", ""])[1])
    .filter((n) => n.length > 0);
}

/**
 * The order the provider passes them in.
 *
 * Read from the comment markers rather than inferred from the code: the closures are
 * anonymous and several are indistinguishable by shape, so there is nothing else to go on.
 * Each capability's closure in `cliOf`/`coreOf` is tagged `/*= name *\/`.
 */
function providerOrder(src: string, fn: string): string[] {
  const start = src.indexOf(`export function ${fn}(`);
  if (start < 0) throw new Error(`no ${fn} in provider.ts`);
  const end = src.indexOf("\n}", start);
  return [...src.slice(start, end).matchAll(/\/\*= (\w+) \*\//g)].map((m) => m[1]);
}

Deno.test("Cli's fields and the provider's arguments are in the same order", async () => {
  const wac = await Deno.readTextFile("packages/platform/src/platform.wac");
  const prov = await Deno.readTextFile("packages/platform/host/provider.ts");

  for (const [struct, fn] of [["Cli", "cliOf"], ["Core", "coreOf"]] as const) {
    const declared = wacOrder(wac, struct);
    const passed = providerOrder(prov, fn);
    assertEquals(
      passed.join(","),
      declared.join(","),
      `${struct} is built positionally and the two orders disagree.\n` +
        `  platform.wac: ${declared.join(", ")}\n` +
        `  provider.ts:  ${passed.join(", ")}`,
    );
    // A guard against the parser silently finding nothing and the comparison passing on two
    // empty lists. Core has five capabilities, Cli twenty-five.
    assertEquals(declared.length >= 5, true, `only ${declared.length} parsed for ${struct}`);
  }
});
