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

  // ── Globbing ────────────────────────────────────────────────────────────────
  //
  // The fake `readDir` answers for `dir` and nothing else, so these reach both the matched and
  // the unmatched sides without needing a real filesystem.
  "echo dir/*", "echo dir/o*", "echo dir/*o", "echo dir/?ne", "echo dir/t?o",
  "echo dir/*.txt", "echo dir/one", "echo nodir/*", "echo *", "echo /*",
  `echo "dir/*"`, `echo 'dir/*'`, `echo dir/"*"`, `echo dir/"*"o`,
  "x=dir/*; echo $x", `x=dir/*; echo "$x"`, "echo dir/* dir/*",
  "echo dir/**", "echo dir/?", "echo ?", "echo dir/",

  // A loop that runs past the bound, so the guard that stops it is reached.
  "while true; do :; done",
];

for (const script of SCRIPTS) {
  m.shOut(script);
  m.shStatus(script);
  m.shErr(script);
}
// The other side of the capture flag: output written through the capability instead of collected.
for (const script of ["echo written", "echo a | rev", "{ echo grouped; }", "echo x > out.txt"]) {
  m.shWritten(script);
}

m.shTouchStubs();

report([run], "packages/sh/", { verbose });
