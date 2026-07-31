# regex

A backtracking regular expression engine, with JavaScript's semantics.

```wac
import { compile, search, slotCount } from "../../regex/src/regex.wac";
import { Program, NO_MATCH } from "../../regex/src/program.wac";

Program? p = compile("(\\w+)@(\\w+)".toBytes());
i32[] caps = i32[slotCount(p!)]();
i32 start = search(p!, "mail me at a@b now".toBytes(), 0, caps, 100000);
// caps holds (start, end) per group; caps[2], caps[3] are the first \w+
```

## Why it is a package

Because `RegExp` is an unusually strong oracle. Most differential tests can only ask "does it
match" — but JavaScript's regexes backtrack, so the *choice* a pattern makes among several
possible matches is specified, not merely the existence of one. `(a|ab)c` on "abc" has exactly
one right answer, and a leftmost-longest engine gives a different one. Comparing capture
positions rather than just the matched text tests the search order itself, which is where a
backtracking engine's semantics actually live.

It is also the first thing here that needed a virtual machine, which turned out to be a language
finding — see below.

## Shape

**A flat program and an explicit stack, because there are no closures.** The textbook matcher is
recursive with a continuation for "the rest of the pattern"; wac cannot spell one. So a pattern
compiles to an instruction array — three `i32` each, opcode and two operands — and matching is a
loop with its own backtracking stack. That is not a workaround: it is the shape that needs
nothing the language does not have, and it made the capture-undo log natural rather than awkward.

**No syntax tree.** The compiler is one pass, emitting as it parses. Every construct needs the
code range of the thing it wraps, and the emitter already knows that: a quantifier records where
its atom started and then inserts an instruction in front of it or copies the range. An AST would
have meant a node type, a hand-written node list and a visitor, for nothing.

The cost is `insertAt`, which shifts emitted code and fixes up jump targets — and that fixup is
where two of the three real bugs lived.

**Quantifiers duplicate rather than count.** `x{2,4}` emits four copies. A counter would be
smaller but would have to live in the backtracking state, and the whole point of the flat program
is that its state is exactly (pc, sp, captures). Expansion is capped, and a pattern past the cap
is refused rather than compiled into something enormous.

## The three bugs, all found by the oracle

**Alternation with three or more branches mis-patched its jumps**, and **two adjacent quantified
atoms broke when the first could match empty**. Both were the same root cause, and it is worth
stating because it is not obvious: when an instruction is inserted at position `at`, a jump
target of exactly `at` means two different things. From *inside* the region being wrapped it means
"the start of this body" and must move; from *before* it, it means "whatever comes next" and must
not — the previous construct's skip target has to land on the newly inserted instruction rather
than step over it. A blanket "shift every target at or past `at`" is right for one and wrong for
the other. `\d*\d*?` is the smallest case that shows it.

**Every iteration of a quantifier resets the capture groups inside its body.** So `(?:(a)|b){2}`
on "ab" reports group 1 as *absent*, not as the "a" the first iteration matched. Missing this
leaves the engine right about the match and wrong about the captures — the half nobody notices
until they read a group. It is now an explicit CLEAR instruction, emitted before the body is
copied so every copy carries its own.

Related, and got right only after asking the oracle: the empty-iteration rule applies **only to
iterations past the minimum**. `(a*)*` on `""` reports group 1 absent, because its one optional
iteration matched empty and was rejected; `(a*)+` reports `[0,0]`, because the first iteration was
mandatory. That is why `x+` compiles to one bare copy followed by a guarded star over a second
copy, rather than one guarded loop.

## Tests

`test/regex.test.ts`: ~2 500 hand-written (pattern, subject) comparisons across every construct,
plus 8 000 generated patterns — half of them with nested groups and alternations, which is where
all three bugs were. Every comparison checks capture positions, not just the match.

`deno task coverage:regex` reports 91%.

Three outcomes are distinguished, and the tests treat them differently:

- **a match or no match** — compared against `RegExp`;
- **pattern refused** — the subset is documented, so a refusal is asserted rather than skipped,
  and the fuzzer fails if it starts refusing more than 15% of generated patterns;
- **step budget exhausted** — catastrophic backtracking, which is a documented outcome and not a
  wrong answer. `(a|a)*b` on a run of a's is exponential in any backtracking engine, JavaScript's
  included. Counted, and the fuzzer fails above 2%.

## The subset

Supported: literals, `.`, classes with ranges and negation, `\d \D \w \W \s \S`, `\b \B`, `^ $`,
groups and `(?:)`, alternation, `* + ? {n} {n,} {n,m}` greedy and lazy, and the usual escapes.

Refused, rather than mis-parsed — which is the dangerous alternative, since `(?=a)` read as a
group containing `?=a` would silently match the wrong thing:

- lookahead and lookbehind, backreferences, named groups, flags;
- a quantified assertion (`^?`, `\b+`), which is a syntax error in JavaScript too;
- `[\D]`, `[\W]`, `[\S]` — a negated shorthand inside a positive class needs set subtraction.

**Bytes, not code points.** A `.` matches one byte, so a multi-byte character is several. `\s` is
the ASCII set where JavaScript's also has Unicode spaces. The tests keep to ASCII for exactly this
reason, and lifting it means a UTF-8-aware machine, not a bigger table.

## Not here yet

- **Anchored search reuse.** `search` retries the machine at each position. A literal prefix scan
  or a Boyer-Moore skip would cut most of that, and neither changes the semantics.
- **A DFA or Thompson simulation for patterns without captures**, which would make the
  pathological cases linear. It is a second engine, not a change to this one, and it cannot
  answer capture questions.
- **Case-insensitive matching**, which is a flag and a fold table.
