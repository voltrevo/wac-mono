// wacc's numeric error codes, against the reference's English.
//
// wac-mono 0005. Sixteen of wacc's twenty surviving mutants were error-code constants — `return 0` in
// place of `errUnexpectedChar`, `perrExpected` and their neighbours — and every test still passed. Both
// differential tests said so out loud: *"compared by count and position, not by message: the wac side
// reports numeric codes and the reference reports English, so the codes are checked by the order and
// place they occur in."* Two distinct errors could share a code, or every code could be zero.
//
// That matters beyond tidiness because rung 3 compares type-checker diagnostics and plans to compare them
// by position too. The rungs would be built on a comparison that never checks the one field wacc uses to
// say *what went wrong*.
//
// ## Two shapes, because the two sides do not categorise alike
//
// The **lexer's** codes line up one-to-one with the reference's messages, so `LEX_CODES` says what each
// one means and every error is checked against it. The **parser's** do not — wacc reports `perrExpected`
// where the reference says `expected function name`, `expected struct name` and more — so it gets claims
// that need no guess: a message shape never comes back as two codes, every code is one the recorded
// numbering declares, and the corpus produces several distinct codes.
//
// ## Why the lexer's table is hand-written, when nothing else here is
//
// `test/lex.test.ts` derives the token-kind names from the reference's own union at run time, so
// reordering it fails loudly instead of comparing the wrong names. That cannot be done for errors,
// because the reference has no error *kinds*: it pushes `{ message, line, col }` with the message built
// by string interpolation at each site. There is nothing to enumerate.
//
// So the mapping is written down, and then *checked* rather than trusted:
//
//   - every code the wac side can emit appears exactly once here;
//   - every message the reference produces in a test's corpus has to match exactly one pattern, so a
//     message that is reworded or added fails rather than being quietly unmatched;
//   - a code with no entry fails, which is what makes `return 0` — the mutant — a failure.
//
// The patterns are deliberately anchored on the part of the message that is not interpolated. Matching
// the whole string would break every time somebody improves the wording, and this test is about which
// error it is, not how it reads.

/** A wacc error code, and the reference message that means the same thing. */
export type CodeMeaning = { code: number; name: string; message: RegExp };

/** `packages/wacc/src/lex.wac` — codes 1..7. */
export const LEX_CODES: readonly CodeMeaning[] = [
  { code: 1, name: "errUnexpectedChar", message: /^unexpected character/ },
  { code: 2, name: "errUnterminatedString", message: /^unterminated string literal/ },
  { code: 3, name: "errUnknownEscape", message: /^unknown escape sequence/ },
  { code: 4, name: "errUnterminatedComment", message: /^unterminated block comment/ },
  { code: 5, name: "errUnterminatedChar", message: /^unterminated character literal/ },
  { code: 6, name: "errEmptyChar", message: /^empty character literal/ },
  { code: 7, name: "errCharTooLong", message: /^character literal must hold exactly one character/ },
];

/**
 * The parser is deliberately *not* given a table, and that is a finding rather than an omission.
 *
 * The lexer's codes line up one-to-one with the reference's messages, which is why `LEX_CODES` can say
 * what each means and be checked. The parser's do not: wacc reports `perrExpected` at sites where the
 * reference says `expected function name`, `expected struct name`, `expected constant name` and more. All
 * nine `perr*` codes are emitted somewhere, so this is not dead code — the two sides simply categorise
 * the same errors at different granularities, and nothing had ever compared them to notice.
 *
 * Writing a table anyway would mean guessing which reference message each code is *supposed* to mean, and
 * then asserting my guess. So the parser gets a weaker claim that needs no guess and still catches the
 * mutants:
 *
 *   - **consistency** — one reference message shape never maps to two different codes. If it did, the
 *     code would be saying two things about the same error.
 *   - **discrimination** — the corpus produces several distinct codes. A constant replaced with
 *     `return 0` collapses categories together, and this is what notices.
 *
 * Whether wacc *should* match the reference's granularity is a real question for whoever owns its
 * diagnostics, and it is recorded in wac-mono 0005 rather than decided here.
 */
export type Observed = { shape: string; code: number; where: string };

/**
 * The parser's codes and their values, recorded rather than derived.
 *
 * Deriving them from the source cannot catch a constant that has been *changed* — which is the whole
 * point here, and the mistake the first version of this check made: it scraped `parse.wac`, so a mutant
 * declaring `perrBadType() { return 0; }` simply moved the goalposts with it and passed.
 *
 * This is not a claim about what each code *means* — that is the guess the parser deliberately does not
 * make. It is a claim about the numbering, which is worth pinning on its own: a code that silently
 * renumbers makes every dump ever taken mean something different.
 */
export const PARSE_CODE_VALUES: ReadonlyMap<number, string> = new Map([
  [20, "perrExpected"],
  [21, "perrBadType"],
  [22, "perrBadPrimary"],
  [23, "perrBadLvalue"],
  [24, "perrTopLevel"],
  [25, "perrFieldName"],
  [26, "perrMethodName"],
  [27, "perrCtorBrace"],
  [28, "perrFnArray"],
]);

/** A reference message with its interpolated parts blanked, so shapes can be compared. */
export const shapeOf = (message: string): string => message.replace(/'[^']*'/g, "'…'");

/**
 * Every `perr*`/`err*` constant the source declares, by value.
 *
 * Read from the source rather than listed, so a code added to the parser is compared from the moment it
 * exists. This is what makes a gutted constant fail: `return 0` produces a code that is not among the
 * declared ones, and a count of distinct codes cannot see that — replacing one value with zero leaves the
 * count exactly where it was, which is how the first version of this check let the mutant through.
 */
export async function declaredCodes(file: string, prefix: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const src = await Deno.readTextFile(file);
  for (const [, name, code] of src.matchAll(new RegExp(`^export i32 (${prefix}[A-Z]\\w*)\\(\\)\\s*\\{\\s*return (\\d+);`, "gm"))) {
    out.set(Number(code), name);
  }
  return out;
}

/** What is wrong with the observed relation, or an empty list. */
export function relationFaults(
  seen: readonly Observed[],
  leastCodes: number,
  declared: ReadonlyMap<number, string>,
): string[] {
  const faults: string[] = [];
  const byShape = new Map<string, { code: number; where: string }>();
  for (const o of seen) {
    const first = byShape.get(o.shape);
    if (first === undefined) {
      byShape.set(o.shape, { code: o.code, where: o.where });
      continue;
    }
    if (first.code !== o.code) {
      faults.push(
        `${JSON.stringify(o.shape)} is code ${first.code} in ${first.where} and ${o.code} in ${o.where}` +
          ` — the same error reported as two different things`,
      );
    }
  }
  for (const o of seen) {
    if (!declared.has(o.code)) {
      faults.push(
        `code ${o.code} came back for ${JSON.stringify(o.shape)} in ${o.where}, and no constant in the ` +
          `source has that value — which is what a constant gutted to \`return 0\` looks like`,
      );
      break;   // one is enough; they will all say the same thing
    }
  }
  const codes = new Set(seen.map((o) => o.code));
  if (codes.size < leastCodes) {
    faults.push(
      `only ${codes.size} distinct code(s) across ${seen.length} errors (${[...codes].sort().join(", ")})` +
        ` — expected at least ${leastCodes}. A constant replaced with \`return 0\` looks exactly like this.`,
    );
  }
  return faults;
}

/**
 * Check one error: the code the wac side reported must mean what the reference said.
 *
 * Returns null when they agree, or the complaint when they do not. A code with no entry is a failure —
 * which is what makes a mutant that returns 0 fail here rather than pass everywhere.
 */
export function disagreement(
  table: readonly CodeMeaning[],
  code: number,
  message: string,
): string | null {
  const entry = table.find((c) => c.code === code);
  if (entry === undefined) {
    return `code ${code} is not one this side can emit (reference said ${JSON.stringify(message)})`;
  }
  const matching = table.filter((c) => c.message.test(message));
  if (matching.length === 0) {
    return `no code matches the reference's ${JSON.stringify(message)} — reword the table, not the test`;
  }
  if (matching.length > 1) {
    return `${JSON.stringify(message)} matches ${matching.map((m) => m.name).join(" and ")}; ` +
      `the patterns overlap and cannot both be right`;
  }
  if (matching[0].code !== code) {
    return `reported ${entry.name} (${code}) where the reference said ${JSON.stringify(message)}, ` +
      `which is ${matching[0].name} (${matching[0].code})`;
  }
  return null;
}

/** Every code appears once. Guards against a table that has drifted from the source it describes. */
export function tableFaults(table: readonly CodeMeaning[]): string[] {
  const faults: string[] = [];
  const seen = new Set<number>();
  for (const c of table) {
    if (seen.has(c.code)) faults.push(`code ${c.code} appears twice`);
    seen.add(c.code);
  }
  return faults;
}
