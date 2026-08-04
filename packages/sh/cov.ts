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
  "echo hello | tr a-z A-Z", "echo abc | tr a- X", "echo a-c | tr -- - _", "echo abc | tr z-a X",
  'echo abc | tr a-c ""', 'echo abc | tr "" X', "echo abc | tr -- a b", "echo abc | tr X z-a",
  "seq 3", "seq 2 4", "seq 4 2", "seq", "seq 1 3 | nl", "echo -n '' | nl",
  String.raw`printf "hi\n"`, "printf", String.raw`printf "%s\n" a b c`,
  String.raw`printf "%d\n" abc`, String.raw`printf "%d\n" -1`, String.raw`printf "%d\n" +1`,
  String.raw`printf "%d\n" -`, String.raw`printf "%d\n" ""`, String.raw`printf "%s-%s\n" a`,
  String.raw`printf "%5s|" ab`, String.raw`printf "%-5s|" ab`, String.raw`printf "%03d" 7`,
  String.raw`printf "%03d" -7`, String.raw`printf "%05s" ab`, String.raw`printf "%.2s" abc`,
  String.raw`printf "%.0s" abc`, String.raw`printf "%x %X %o" 255 255 8`,
  String.raw`printf "%x" 0`, String.raw`printf "%x" -255`, String.raw`printf "%c" abc`,
  String.raw`printf "%c" ""`, String.raw`printf "%%"`, String.raw`printf "%z" x`,
  "printf '%'", "printf 'ab%'", String.raw`printf "\n\t\r\\\\\a\b\f\v\e"`,
  String.raw`printf "\x41"`, String.raw`printf "\x4a"`, String.raw`printf "\x4A"`,
  String.raw`printf "\x"`, String.raw`printf "\xZ"`, String.raw`printf "%x" abc`,
  String.raw`printf "\101"`, String.raw`printf "\0101"`, String.raw`printf "\q"`,
  "printf '\\'", String.raw`printf "%s" a b c d`,

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

  // ── Parameter expansion ─────────────────────────────────────────────────────
  //
  // Every operator, on both sides of set/unset/empty — which is three states, not two, and the
  // colon is what tells the last two apart.
  "echo ${u:-d}", "x=v; echo ${x:-d}", "x=; echo ${x:-d}",
  "echo ${u-d}", "x=v; echo ${x-d}", "x=; echo ${x-d}",
  "echo ${u:+a}", "x=v; echo ${x:+a}", "x=; echo ${x:+a}",
  "echo ${u+a}", "x=v; echo ${x+a}", "x=; echo ${x+a}",
  "echo ${u:=a}", "x=v; echo ${x:=a}", "x=; echo ${x:=a}",
  "echo ${u=a}", "x=v; echo ${x=a}",
  "echo ${u:?}", "echo ${u:?why}", "x=v; echo ${x:?why}",
  "echo ${u?}", "x=v; echo ${x?}",
  "echo ${#u}", "x=hello; echo ${#x}", "x=; echo ${#x}",
  "echo ${#}", "echo ${@}", "echo ${*}", "echo ${?}", "echo ${1}",
  "y=i; echo ${x:-$y}", "y=i; echo ${x:-${y}}", "echo ${x:-a b}", 'echo "${x:-a b}"',
  "echo ${x}", "x=v; echo ${x}tail", "echo ${}", "echo ${:-d}", "echo ${x:", "echo ${",
  "echo ${x:-}", "echo ${x-}", "echo ${x:+}",
  "f() { echo ${1:-d}; }; f; f given",

  // Prefix assignments, which are restored afterwards — including the unset case.
  "x=1 true; echo [$x]", "x=0; x=1 true; echo $x", "x=1 y=2 true", "x=1 nosuchcommand",
  "x=1 exit 0", "x=$(echo v) true; echo [$x]",

  // ── Case conversion ─────────────────────────────────────────────────────────
  "x=abc; echo ${x^}", "x=abc; echo ${x^^}", "x=ABC; echo ${x,}", "x=ABC; echo ${x,,}",
  "x=abc; echo ${x^a}", "x=abc; echo ${x^b}", "x=abc; echo ${x^^[ab]}", "x=abc; echo ${x,,[AB]}",
  "x=; echo ${x^}", "x=abc; echo ${x!}", "x=abc; echo ${x&}", "x=abc; echo ${x^^?}",
  "echo ${?-x}", "echo ${#-x}", "echo ${@-x}", "echo ${*-x}", "set -- a; echo ${@-x}",
  "set -- a b; echo ${#@}", "set -- a b; echo ${#*}",

  // ── Substrings ──────────────────────────────────────────────────────────────
  "x=abcdef; echo ${x:1:2}", "x=abcdef; echo ${x:2}", "x=abc; echo ${x::2}",
  "x=abc; echo ${x:1:}", "x=abcdef; echo ${x: -2}", "x=abc; echo ${x: -9}",
  "x=abcdef; echo ${x:1:-1}", "x=abc; echo ${x:1:-9}", "x=abc; echo ${x:9}",
  "x=abc; echo ${x:1:9}", "x=abc; echo ${x:}", "x=abc; echo ${x:abc}",
  "x=abcdef; n=2; echo ${x:n:n}", "x=abcdef; echo ${x:$((1+1)):2}", "x=abc; echo ${x:0}",
  "echo ${x:1}", "x=abc; echo ${#x:1}", "x=abc; echo ${#x}", "echo ${#?}", "echo ${#1}",
  "echo ${#@}", "echo ${#nosuch}", "echo ${#1x}", 'echo "${#x-}"',

  // ── Arithmetic ──────────────────────────────────────────────────────────────
  "echo $((1+2))", "echo $((5-2))", "echo $((2*3))", "echo $((7/2))", "echo $((7%2))",
  "echo $(( (1+2)*3 ))", "echo $((2*3+4*5))", "echo $((-5))", "echo $((+5))", "echo $((!0))",
  "echo $((1<2)) $((2<1)) $((1<=1)) $((2<=1))",
  "echo $((2>1)) $((1>2)) $((1>=1)) $((1>=2))",
  "echo $((1==1)) $((1==2)) $((1!=2)) $((1!=1))",
  "echo $((1&&1)) $((1&&0)) $((0||1)) $((0||0))",
  "x=5; echo $((x))", "x=5; echo $(($x))", "x=5; echo $((${x}))", "echo $((unset))",
  "x=abc; echo $((x))", "x=-7; echo $((x))", "x=' 9 '; echo $((x))", "x=1+2; echo $((x))",
  "echo $(( ))", "echo $((   ))", "echo $((0))",
  "echo $((1/0))", "echo $((1%0))", "echo $((1+))", "echo $((a b))", "echo $(($))",
  "echo $((()))", "echo $(((1))", "echo $((1)", "echo $(( (1 ))", "echo $(( (1+2 ))",
  "echo $((!5))", "echo $((!!0))", "x=' 9 '; echo $((x))", "x='9 '; echo $((x))",
  "x=' '; echo $((x))", "x=+4; echo $((x))", "x=-; echo $((x))",
  "i=0; while test $i -lt 3; do i=$((i+1)); done; echo $i",
  "echo $(echo plain)", "echo $( (echo sub) )",

  // ── Trimming and bracket classes ────────────────────────────────────────────
  "f=a.txt; echo ${f%.txt}", "f=a.b.c; echo ${f%.*}", "f=a.b.c; echo ${f%%.*}",
  "p=/x/y/z; echo ${p#*/}", "p=/x/y/z; echo ${p##*/}", "p=/x/y/z; echo ${p%/*}",
  "x=hello; echo ${x#h}", "x=hello; echo ${x%o}", "x=hello; echo ${x#no}", "x=hello; echo ${x%no}",
  "x=abc; echo ${x#?}", "x=abc; echo ${x%%?}", "x=; echo [${x#a}]", "echo [${u#a}]",
  "x=abc; echo ${x#}", "x=abc; echo ${x%}", "y=b; x=abc; echo ${x#$y}", "x=hello; echo ${#x}",
  "case b in [abc]) echo y;; esac", "case d in [abc]) echo n;; esac",
  "case q in [a-z]) echo y;; esac", "case Q in [a-z]) echo n;; esac",
  "case 5 in [0-9]) echo y;; esac", "case x in [!abc]) echo y;; esac",
  "case a in [!abc]) echo n;; esac", "case a in [^abc]) echo n;; esac",
  "case - in [a-]) echo y;; esac", "case a in []a]) echo y;; esac",
  "case a in [) echo n;; esac", "echo [", "echo []", "echo [abc",
  "echo dir/[ot]*", "echo dir/[!o]*", "echo dir/[a-z]*",

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

  // ── read, set and shift ─────────────────────────────────────────────────────
  "echo x | { read a; echo [$a]; }", "echo a b c | { read x y z; echo $x$y$z; }",
  "echo a b c d | { read x y; echo $y; }", "echo a b | { read x; echo $x; }",
  "seq 1 2 | { read a; read b; read c; echo $?; }", "echo -n ab | { read x; echo $x $?; }",
  "echo hi | { read; echo $REPLY; }", "read x; echo $?",
  "seq 1 3 | while read x; do echo $x; done",
  "while read x; do echo $x; done <<EOF\np\nq\nEOF",
  "{ read a; cat; } <<EOF\n1\n2\nEOF", "while read x; do echo $x; done < in.txt",
  "while read x; do echo $x; done < nosuch.txt",
  "read a b < in.txt", "read -r a < in.txt", "read -r -r a < in.txt",
  "echo 'a\\ b' | { read x y; echo $x; }", "echo 'a\\ b' | { read -r x y; echo $x; }",
  "echo 'a\\' | { read x; echo $x; }", "echo '\\tt' | { read a b; echo $b; }",
  'echo "a b  " | { read x y; echo $y; }',      // trailing blanks the last name must lose
  "set -- a b c; echo $#", "set a b c; echo $1", "set", "set -e", "set -- ", "set --",
  "x=1; y=2; set",                              // bare `set` with something to list
  "z=1; a=2; set",                              // and out of order, so the sort has work to do
  "set -- a b c; shift; echo $1", "set -- a b c; shift 2; echo $1", "set -- a; shift 2; echo $?",
  "shift; echo $?", "set -- a; shift x; echo $?", "f() { shift; echo $1; }; f 1 2",

  // ── Backquotes ──────────────────────────────────────────────────────────────
  "echo `echo hi`", "echo a`echo b`c", 'echo "`echo hi`"', "echo \'`echo hi`\'",
  "x=`echo v`; echo $x", "echo `seq 1 3`", 'echo "`seq 1 3`"', "echo ``", 'echo ""``',
  "echo `", 'echo "`"', "echo `echo \\`in\\``", "echo `echo \\$x`", "echo `echo \\\\`",
  "echo `echo \\q`", "cat <<EOF\n`echo hd`\nEOF", "cat <<EOF\n`unterminated\nEOF",
  // Literal text before the backquote, which is a different flush from starting a part with it.
  'echo "a`echo b`"', "cat <<EOF\nx `echo y`\nEOF",
  "x=$(false); echo $?", "x=$(exit 3); echo $?", "x=1; echo $?", "$(exit 3); echo $?",
  "a=$(false) b=$(true); echo $?",

  // ── Pattern substitution ────────────────────────────────────────────────────
  "x=abcabc; echo ${x/b/Z}", "x=abcabc; echo ${x//b/Z}", "x=aaa; echo ${x/a*/X}",
  "x=abc; echo ${x/#a/Z}", "x=abc; echo ${x/#z/Z}", "x=abc; echo ${x/%c/Z}",
  "x=abc; echo ${x/%z/Z}", "x=abc; echo ${x/z/Z}", "x=abc; echo ${x//z/Z}",
  "x=abc; echo ${x/b}", "x=abc; echo ${x//}", "x=abc; echo ${x/}",
  'x=abc; echo "${x//""/-}"', "x=; echo ${x/a/b}", "x=a/b; echo ${x/\\//-}",
  'x=abc; echo "${x//?/[&]}"', 'x=abc; echo "${x/b/\\&}"', 'x=abc; echo "${x/b/&}"',
  "x=abc; echo ${x/#/Z}", "x=abc; echo ${x/%/Z}", "x=abc; echo ${x//*/X}",
  'x="a b"; echo "${x#a }"', 'x="a b"; echo "${x%% b}"',

  // ── Spawning an external program ────────────────────────────────────────────
  //
  // The fake world has `/bin/prog`, which starts, and `/bin/badprog`, which does not. See the
  // spawn section of `test/wac/probe.wac` for why those are the only two outcomes reachable here.
  "WACPATH=/bin; prog", "WACPATH=/bin; prog a b", "echo x | { WACPATH=/bin; prog; }",
  "WACPATH=/bin; badprog", "WACPATH=/bin; nosuchprog",
  "WACPATH=/nowhere:/bin; prog", "WACPATH=::/bin; prog", "WACPATH=/nowhere; prog",
  "WACPATH=; prog", "prog",
  "/bin/prog", "/bin/badprog", "./nosuch/prog", "WACPATH=/bin; /bin/prog",
  "WACPATH=/bin; goneprog",                     // starts, then reports no status: 126, not 0
  "WACPATH=/bin; ghost",                        // stat says yes, read says no: 127
  "WACPATH=/bin; echo hi",                      // a world with no spawn at all: falls through
  '"" x',                                       // an empty command name

  // ── Here-documents ──────────────────────────────────────────────────────────
  //
  // Weighted towards the malformed ones. The well-formed shapes are covered by the differential
  // suite, which can check them against bash; these are the ones bash and we agree to reject or
  // where there is nothing to compare, and they are what reaches the lexer's error paths.
  "cat <<EOF\nhello\nEOF", "cat <<EOF\na\nb\nEOF", "cat <<EOF\nEOF",
  "x=1; cat <<EOF\nv=$x\nEOF", "x=1; cat <<'EOF'\nv=$x\nEOF", "x=1; cat <<\"EOF\"\nv=$x\nEOF",
  "x=1; cat <<\\EOF\nv=$x\nEOF", "x=1; cat <<E'O'F\nv=$x\nEOF",
  "cat <<EOF\n$(echo s) $((1+1)) ${x-d}\nEOF",
  "cat <<EOF\n\\$x \\\\ \\n \\\"\nEOF",
  "cat <<-EOF\n\ttab\n\tEOF", "cat <<-EOF\n\t\ta\n  spaces\n\tEOF", "cat <<-EOF\nEOF",
  "cat <<EOF | rev\nabc\nEOF", "cat <<EOF > out.txt\nx\nEOF", "wc -l <<EOF\na\nb\nEOF",
  "cat <<A <<B\n1\nA\n2\nB", "cat 0<<EOF\nfd\nEOF", "cat 3<<EOF\nodd fd\nEOF",
  "if true; then cat <<EOF\nin\nEOF\nfi", "for i in 1 2; do cat <<EOF\n$i\nEOF\ndone",
  "f() { cat <<EOF\nfn\nEOF\n}; f", "v=$(cat <<EOF\nc\nEOF\n); echo $v",
  // Nothing closes these, or nothing opens them properly.
  "cat <<EOF", "cat <<EOF\nunterminated", "cat <<", "cat <<\n", "cat << ", "cat <<;",
  "cat <<-", "cat <<EOF\nEOFX\nxEOF", "cat <<'EOF'\nno end",
  "<<EOF\nno command\nEOF", "cat <<EOF EOF\nboth\nEOF", "cat 3<<", "cat <<''\nempty delim",
  // A body is lexed as if double-quoted, so it has the same malformed-expansion cases a "…" has.
  "cat <<EOF\na $ b\nEOF", "cat <<EOF\n${}\nEOF", "cat <<EOF\n${unclosed\nEOF",
  "cat <<EOF\ntrailing $\nEOF",

  // ── The parser's refusals ───────────────────────────────────────────────────
  //
  // Malformed input, which is most of what is left uncovered in `parse.wac`: the differential
  // suite cannot reach a refusal, because bash and this agree on what works and differ by
  // construction on what this declines to do.
  "{ cat; } 0<<EOF\nx\nEOF",                     // an explicit fd on a compound's here-doc
  "{ cat; } 3<<EOF\nx\nEOF",
  "{ echo a; } >", "{ echo a; } <", "{ echo a; } >>", "{ echo a; } > ;",
  "echo a >>", "echo a >> ;",                     // `>>` with no target, in a simple command
  "(echo a; }", "(echo a } )", "case a in a b esac", "case a in a|b esac",
  "for a$b in x; do echo; done",                  // a variable name that is not one part
  "a$b() { echo; }",                              // and a function name that is not
  "case a in a echo x;; esac",                    // an arm with no `)`
  "case a in", "case", "case a", "case a in a", "case a in a)",
  ")", "&&", ";", "( )", "{ }", "{ ;}",
  "if true; then ) fi", "while ) ; do :; done", "for x in a; do ) ; done",
  "(echo a) )", "{ echo a; } )",

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
