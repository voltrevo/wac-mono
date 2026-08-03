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
//
// **It has to check that each marker is attached to the argument it names, not merely that the
// markers appear in the right order.** The first version checked the order alone, and I put the
// markers in the right sequence on the wrong lines — scattered through the resolver helpers
// above the call, where they annotated nothing. It passed for two commits, including one that
// inserted a capability in the middle of `Core`, while proving only that a list of comments was
// sorted. So the parser below splits the actual argument list and requires every argument to
// begin with its own marker: a stray marker or an untagged argument is a failure.

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/**
 * Split a call's argument list at depth zero.
 *
 * Strings and comments are skipped rather than scanned, because both contain commas: a
 * parameter type like `fn[bool(string, u8[])]` has one inside brackets, and the prose above
 * `spawn` has one in a line comment. A regex that ignored either produced phantom
 * capabilities named `string` and `i32`.
 */
function splitArgs(src: string, open: number): { parts: string[]; end: number } {
  const parts: string[] = [];
  let i = open + 1, depth = 0, at = open + 1;
  for (; i < src.length; i++) {
    const c = src[i], two = src.slice(i, i + 2);
    if (two === "//") { i = src.indexOf("\n", i); continue; }
    if (two === "/*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) { parts.push(src.slice(at, i)); break; }
      depth--;
    } else if (c === "," && depth === 0) { parts.push(src.slice(at, i)); at = i + 1; }
  }
  if (parts.length > 0 && parts[parts.length - 1].trim() === "") parts.pop();   // trailing comma
  return { parts, end: i };
}

/** The parameter names of `<Struct> of(...)` in platform.wac, in order. */
function wacOrder(src: string, struct: string): string[] {
  const at = src.indexOf(`  ${struct} of(`);
  if (at < 0) throw new Error(`no ${struct}.of in platform.wac`);
  // Each part is `<type> <name>`; the name is the trailing identifier.
  return splitArgs(src, src.indexOf("(", at)).parts
    .map((x) => (x.trim().match(/([A-Za-z_][A-Za-z0-9_]*)$/) ?? ["", ""])[1])
    .filter((n) => n.length > 0);
}

/**
 * The order the provider passes them in, taken from the marker at the head of each argument.
 *
 * Read from markers rather than inferred from the code because the closures are anonymous and
 * several are indistinguishable by shape — `(path: string) => T.stat(…)` and its neighbours
 * differ only in the opcode. Requiring the marker to *lead* the argument is what makes this a
 * check rather than a decoration: a marker that has drifted onto a helper is no longer at the
 * head of anything, so it fails instead of quietly still matching.
 */
function providerOrder(src: string, struct: string): string[] {
  const call = `return cls.${struct}.of(`;
  const at = src.indexOf(call);
  if (at < 0) throw new Error(`no cls.${struct}.of in provider.ts`);
  const { parts, end } = splitArgs(src, src.indexOf("(", at));

  // Nothing outside the argument list may carry a marker, or a stray could pair with an
  // argument by position and hide exactly the drift this is looking for.
  const inside = src.slice(at, end);
  const outside = src.replace(inside, "");
  const strays = [...outside.matchAll(/\/\*= (\w+) \*\//g)].map((m) => m[1]);

  return parts.map((part, i) => {
    const m = part.match(/^\s*(?:\n\s*)*\/\*= (\w+) \*\//);
    if (m === null) {
      throw new Error(
        `${struct} argument ${i} has no /*= name */ marker at its head:\n  ${part.trim().slice(0, 90)}` +
          (strays.length > 0 ? `\n  markers found outside the call: ${strays.join(", ")}` : ""),
      );
    }
    // The marker is what the author *says* this argument is. The opcode inside it is what the
    // argument actually does, and comparing the two is the only part of this test that checks
    // the wiring rather than a label: swapping two argument bodies and leaving the markers
    // alone would otherwise pass, which is the same mistake as before wearing a different hat.
    const ops = new Set([...part.matchAll(/\bOP\.([A-Z_]+)\b/g)].map((x) => x[1]));
    if (ops.size === 1) {
      const op = [...ops][0];
      const expected = OP_NAME[op] ?? op.toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase());
      if (expected !== m[1]) {
        throw new Error(
          `${struct} argument ${i} is marked ${m[1]} but submits OP.${op}, which is ${expected}`,
        );
      }
    }
    return m[1];
  });
}

/**
 * Capabilities whose name is not their opcode in camelCase.
 *
 * Only one, and it earns the exception: `write` goes to standard output, and the opcode says
 * so. `waitAny` submits no opcode at all — the wait is in this worker's own memory — so it is
 * checked by position and marker alone.
 */
const OP_NAME: Record<string, string> = { WRITE_STDOUT: "write" };

Deno.test("Cli's fields and the provider's arguments are in the same order", async () => {
  const wac = await Deno.readTextFile("packages/platform/src/platform.wac");
  const prov = await Deno.readTextFile("packages/platform/host/provider.ts");

  for (const struct of ["Cli", "Core"] as const) {
    const declared = wacOrder(wac, struct);
    const passed = providerOrder(prov, struct);
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
