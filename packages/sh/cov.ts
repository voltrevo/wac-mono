// Branch coverage for sh.
//
// Scripts, not unit calls: the lexer, parser and executor are one pipeline and the only honest
// way to reach a branch in the middle is to write the shell script that gets there.
//
// The capabilities are faked inside wac (see `test/wac/probe.wac`), so this is a list of scripts
// and nothing else. The interesting ones are the refusals — every place a peer, a file or a
// script can be wrong — because those are the branches a differential suite against bash cannot
// reach: bash and this agree on what *works*, and disagree by construction on what this declines
// to do.
//
//   deno task coverage:sh
//   deno task coverage:sh --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");

const run = await instrument("packages/sh/test/wac/probe.wac");
const m = run.mod as unknown as {
  shOut(src: string): Uint8Array;
  shStatus(src: string): number;
  shErr(src: string): Uint8Array;
  shWritten(src: string): number;
  shTouchStubs(): number;
};

const SCRIPTS: string[] = [
  // ── Words, quoting and the lexer ────────────────────────────────────────────
  "", " ", "\n", "\n\n", "# comment", "  # indented comment", "echo a # trailing",
  "echo hello", "echo a b c", "echo   spaced   ", "echo a#b",
  `echo "double"`, `echo 'single'`, `echo a"b"c`, `echo "a"'b'c`, `echo ""`, `echo ''`,
  `echo a\\ b`, `echo \\$notavar`, `echo "\\$literal"`, `echo "\\\\"`, `echo "\\q"`,
  `echo 'it$x'`, `echo "it$SET_IN_ENV"`, "echo a\\\nb",
  `echo "unterminated`, `echo 'unterminated`, `echo "$("`,
  "echo $", `echo "$"`, "echo ${}", "echo $1", "echo $$", "echo $#", "echo $!",
  "echo ${SET_IN_ENV}", "echo $SET_IN_ENV", "echo $UNSET_ANYWHERE",

  // ── Assignments ─────────────────────────────────────────────────────────────
  "x=1", "x=1; echo $x", "x=; echo [$x]", "x=a b", "1x=bad", "=bad", `"x"=bad`,
  "x=1 echo prefixed", "x=$(echo sub); echo $x", "x=a; x=b; echo $x",

  // ── Redirection ─────────────────────────────────────────────────────────────
  "echo out > out.txt", "echo out >> out.txt", "cat < in.txt", "cat < nosuch.txt",
  "echo x > readonly.txt", "echo x 2> out.txt", "> out.txt echo leading",
  "echo a > out.txt > out.txt", "cat < in.txt | rev",
  "echo x >", "echo x > ;", "echo x <",

  // ── Pipelines and lists ─────────────────────────────────────────────────────
  "echo a | rev", "echo a | rev | rev", "seq 1 3 | wc -l", "true && echo y", "false || echo y",
  "true; false; echo $?", "echo a &", "true &&", "| echo", "&& echo",
  "echo a\necho b", "echo a &&\necho b", "echo a |\nrev",

  // ── Builtins ────────────────────────────────────────────────────────────────
  ":", "true", "false", "echo -n x", "exit", "exit 5", "export A=1; echo $A", "export noequals",
  "unset A", "help",
  "test", "test x", "test ''", "test -z ''", "test -n x", "test ! ''", "test -q x",
  "test a = a", "test a != b", "test 1 -eq 1", "test 1 -ne 2", "test 1 -lt 2", "test 2 -le 2",
  "test 3 -gt 2", "test 3 -ge 3", "test a -bad b", "test a b c d",
  "[ a = a ]", "[ a = a", "nosuchcommand",

  // ── The programs ────────────────────────────────────────────────────────────
  "cat", "cat in.txt", "cat nosuch.txt", "cat in.txt in.txt", "echo x | cat -",
  "seq 1 3 | wc", "seq 1 3 | wc -l", "seq 1 3 | wc -w", "seq 1 3 | wc -c",
  "seq 1 20 | head", "seq 1 20 | head -n 3", "echo -n noeol | head -n 5",
  "seq 1 20 | tail", "seq 1 20 | tail -n 3", "seq 1 2 | tail -n 99",
  "echo abc | rev", "cat words.txt | sort", "cat words.txt | sort -r",
  "echo -n '' | sort", "printf | uniq", "cat in.txt | uniq",
  "echo aa | grep a", "echo aa | grep z", "echo aa | grep -v z", "echo aa | grep",
  "echo abc | tr ab xy", "echo abc | tr abc x", "echo abc | tr", "echo abc | tr a",
  "seq 3", "seq 2 4", "seq 4 2", "seq", "seq 1 3 | nl", "echo -n '' | nl",

  // ── Command substitution ────────────────────────────────────────────────────
  "echo $(echo a)", `echo "$(echo a)"`, "echo $(false)", "echo $(seq 1 3)",
  "echo $(echo a; echo b)", "echo $(nosuchcommand)", "echo a$(echo b)c", "echo $(exit 3)",

  // ── Compound commands ───────────────────────────────────────────────────────
  "if true; then echo y; fi", "if false; then echo n; fi",
  "if false; then echo n; else echo e; fi",
  "if false; then echo a; elif true; then echo b; fi",
  "if false; then echo a; elif false; then echo b; else echo c; fi",
  "if false; then echo a; elif false; then echo b; fi",
  "if true; then echo a; fi > out.txt",
  "if", "if true", "if true; then", "if true; then echo a", "if; then echo a; fi",
  "if true; then echo a; else", "if true; then echo a; junk",
  "for x in a b; do echo $x; done", "for x in; do echo $x; done", "for x; do echo $x; done",
  "for x in a; do echo $x; done > out.txt",
  "for", "for x", "for x in a", "for x in a; do", "for x in a; do echo", "for 1x in a; do echo; done",
  `for "x" in a; do echo; done`, "for do in a; do echo; done",
  "while false; do echo n; done", "x=1; while test $x -lt 3; do echo $x; x=$(seq 2 2); done",
  "while", "while true", "while true; do", "while; do echo; done",
  "until true; do echo n; done", "x=1; until test $x -gt 1; do echo $x; x=$(seq 2 2); done",
  "{ echo a; }", "{ echo a; echo b; }", "{ echo a; } | rev", "{ echo a; } > out.txt",
  "{", "{ echo a", "{ echo a; } junk",
  "for x in a b; do if test $x = b; then echo hit; fi; done",
  "if true; then while false; do echo n; done; fi",
  "echo if", "echo then", "echo done", "echo }",

  // ── Reaching what the shapes above miss ─────────────────────────────────────
  "exit 1; echo never",                            // `exiting` short-circuits a list
  "f() { exit 2; }; f; echo never",
  "(exit 1; echo never)",
  "for x in a b; do exit 1; done; echo never",
  "while true; do exit 1; done",
  "if true; then exit 1; fi; echo never",
  "case a in a) exit 1;; esac; echo never",
  "{ exit 1; }; echo never",
  "false && echo skipped",                         // the `And` arm that does not run
  "true && false && echo skipped",
  "{ echo a; } >> out.txt",                        // append on a compound
  "( echo a ) >> out.txt",
  "if true; then echo a; fi >> out.txt",
  "{ echo a; } < in.txt",                          // an input redirection on a compound
  "{ echo a; }",                                   // a compound that writes rather than collects
  "echo dir/.*",                                   // a pattern that starts with a dot
  "echo dir/*e",
  "echo 2>&1",                                     // `2` then a redirection with no space
  "echo a 2>> out.txt",
  "echo a 0< in.txt",
  "echo a 9> out.txt",
  "test -1 -eq -1",                                // a negative number through atoi
  "test - -eq 0",                                  // a lone minus
  "test x -eq 1",                                  // a non-number
  "test '' -eq 0",
  "echo \\",                                        // a trailing backslash
  "echo a\\",
  "x=$(echo a; exit 3); echo $x$?",

  "for x in a b c; do if test $x = b; then exit 1; fi; done",
  "until false; do exit 1; done",
  "case a in a) echo x;; esac | rev",
  "f() { echo x; }; f | rev",
  "echo dir/.h*", "echo dir/.*", "echo dir/t*", "echo dir/*e", "echo dir/three",

  "if true; then echo a & fi",                      // `&` inside a compound body
  "while true; do echo a & done",
  "for x in do; do echo $x; done",                 // a word that is also a keyword
  "for x in a do echo",
  "a1=1; echo $a1",                                // a digit inside a name
  "_x=1; echo $_x",
  "$x=1",                                          // first part is an expansion, not a name
  '"x"=1',                                         // first part is quoted
  "=1", "1x=1", "x-y=1", "x =1", "x= 1",
  "case a in a) echo x;; esac",
  "f() { echo a; } > out.txt",

  // ── The programs' edges ─────────────────────────────────────────────────────
  //
  // Comparisons and splitting have cases a shell script reaches only with the right shapes:
  // equal-length lines that differ, a line with no trailing newline, an empty needle.
  "echo a | cat - - | uniq",                       // adjacent duplicates
  "seq 10 11 | uniq",                              // same length, different
  "seq 1 12 | sort",                               // different lengths, sorted
  "seq 1 12 | sort -r",
  "echo -n ab | rev",                              // no trailing newline
  "echo -n ab | wc -c",
  "echo -n ab | sort",
  "echo -n ab | uniq",
  "echo -n ab | nl",
  "echo abc | tr abc ''",                          // an empty second set
  "echo abc | tr '' x",                            // an empty first set
  "echo a | grep ''",                              // an empty needle
  "echo a | grep abcdef",                          // needle longer than the line
  "cat in.txt | grep alpha",
  "cat in.txt | uniq",
  "seq 1 3 | head -n 0",
  "seq 1 3 | tail -n 0",
  "seq 5 5 | wc -l",
  "seq 1 1 | sort",

  // ── Globbing ────────────────────────────────────────────────────────────────
  //
  // The fake `readDir` answers for `dir` and nothing else, so these reach both the matched and
  // the unmatched sides without needing a real filesystem.
  "echo dir/*", "echo dir/o*", "echo dir/*o", "echo dir/?ne", "echo dir/t?o",
  "echo dir/*.txt", "echo dir/one", "echo nodir/*", "echo *", "echo /*",
  `echo "dir/*"`, `echo 'dir/*'`, `echo dir/"*"`, `echo dir/"*"o`,
  "x=dir/*; echo $x", `x=dir/*; echo "$x"`, "echo dir/* dir/*",
  "echo dir/**", "echo dir/?", "echo ?", "echo dir/",

  // ── case ────────────────────────────────────────────────────────────────────
  "case a in a) echo hit;; esac", "case b in a) echo no;; b) echo yes;; esac",
  "case x in a|b|x) echo alt;; esac", "case f.txt in *.txt) echo t;; esac",
  "case f in *) echo d;; esac", "case f in a) echo no;; esac",
  "case a in (a) echo p;; esac", "case a in a) ;; esac",
  "case a in a) echo one; echo two;; esac", "case a in a) echo x;; esac > out.txt",
  `case "a b" in "a b") echo q;; esac`, `case '*' in "*") echo lit;; esac`,
  "x=b; case $x in b) echo e;; esac", "case a in a) echo x;; b) echo y;; esac",
  "case a in\n  a) echo nl ;;\nesac",
  // Malformed: every way an arm can be wrong.
  "case", "case a", "case a in", "case a in a", "case a in a)", "case a in a) echo x",
  "case a in a) echo x;;", "case a in )", "case a in a b) echo x;; esac",
  "case a in a|) echo x;; esac", "case a in a| ;; esac", "case ;; esac",
  "case a in esac", "case a in a) echo x;; esac junk",

  // ── Functions ───────────────────────────────────────────────────────────────
  "f() { echo fn; }; f", "f() { echo $1; }; f arg", "f() { echo $#; }; f a b",
  "f() { echo $#; }; f", `f() { echo "$@"; }; f a b`, `f() { echo "$*"; }; f a b`,
  "f() { echo $9; }; f a", "f() { x=1; }; f; echo $x", "f() { false; }; f; echo $?",
  "f() { echo a; }; f | rev", "f() { seq 1 2; }; f | wc -l",
  "outer() { inner; }; inner() { echo n; }; outer",
  "f() { echo a; }; f > out.txt", "f() { exit 4; }; f; echo after",
  "f() { echo x; }; f; f; f",
  "f() { if true; then echo t; fi; }; f",
  // Malformed definitions.
  "f()", "f( )", "f() ", "f() echo notcompound", "f(x) { echo x; }", "() { echo x; }",

  // ── Subshells ───────────────────────────────────────────────────────────────
  "(echo a)", "(echo a; echo b)", "x=1; (x=2; echo $x); echo $x", "(exit 3); echo $?",
  "(echo s) | rev", "(true) && echo ok", "(false) || echo ko", "(seq 1 2) | wc -l",
  "f() { echo fn; }; (f)", "(f() { echo i; }; f)", "(echo a) > out.txt",
  "( )", "(", "(echo a", "()", "(;)", "( ; echo a )",
  "echo $( (echo n) )", "((echo a))",

  // A loop that runs past the bound, so the guard that stops it is reached.
  "while true; do :; done",
];

/**
 * Every prefix of a script, cut at whitespace.
 *
 * A compound command has a truncation path at each of its keywords — `if`, `if true`, `if true;
 * then`, and so on — and writing them out by hand misses some and duplicates others. Generating
 * them reaches every "ran out of tokens" branch in one go.
 */
function prefixes(script: string): string[] {
  const words = script.split(" ");
  const out: string[] = [];
  for (let i = 1; i < words.length; i++) out.push(words.slice(0, i).join(" "));
  // Word boundaries are too coarse for the parser: `f()` and `a|b)` are one word each and their
  // interesting truncations are inside. Every character cut catches those, and the duplicates
  // cost nothing.
  for (let i = 1; i < script.length; i++) out.push(script.slice(0, i));
  return out;
}

for (
  const complete of [
    "if true; then echo a; elif false; then echo b; else echo c; fi",
    "while true; do echo a; done",
    "until true; do echo a; done",
    "for x in a b; do echo $x; done",
    "case a in a|b) echo x;; *) echo y;; esac",
    "{ echo a; echo b; }",
    "( echo a; echo b )",
    "f() { echo a; }",
    "echo a | rev | wc -l",
    "echo a && echo b || echo c",
    "echo a > out.txt",
    "cat < in.txt",
    "case a in a) echo x ;; b) echo y ;; esac",
    "f() { echo a; echo b; }",
    "for x in a b c; do echo $x; done",
    "if a; then b; elif c; then d; else e; fi",
  ]
) {
  SCRIPTS.push(complete);
  for (const p of prefixes(complete)) SCRIPTS.push(p);
}

// Shapes the prefixes do not reach: a bad token where a list may start, and the separators.
for (
  const odd of [
    `"unterminated`, "'unterminated", "; echo a", ";; echo a", "&", "& echo a",
    "echo a &", "echo a & echo b", "\necho a", "echo a\n\necho b",
    "if true; then echo a\necho b; fi",
    "( echo a\necho b )", "( echo a & )", "for x in a\ndo echo $x; done",
    ") echo a", "esac", "then echo a", "do echo a", "done", "fi", "}",
    "case a in a) echo x\n;; esac",
  ]
) {
  SCRIPTS.push(odd);
}

for (const script of SCRIPTS) {
  m.shOut(script);
  m.shStatus(script);
  m.shErr(script);
}
// The other side of the capture flag: output written through the capability instead of collected.
for (
  const script of [
    "echo written", "echo a | rev", "{ echo grouped; }", "echo x > out.txt",
    "if true; then echo i; fi", "for x in a; do echo $x; done", "while false; do :; done",
    "case a in a) echo c;; esac", "( echo s )", "f() { echo f; }; f",
    "echo dir/*", "exit 1", "nosuchcommand",
  ]
) {
  m.shWritten(script);
}

m.shTouchStubs();

report([run], "packages/sh/", { verbose });
