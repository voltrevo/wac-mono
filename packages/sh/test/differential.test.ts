// Imported for its side effect: retries a spawn that fails with "Text file busy" and names
// whoever held the file, if anyone did. wac-mono 0074.
import { appRunner } from "../../../harness/appRun.ts";
import { pool } from "../../../harness/inFlight.ts";
import { buildApp } from "../../platform/build.ts";
import "../../../harness/spawnRetry.ts";
// The shell, against bash.
//
// Every script here runs through GNU bash and through ours, and the two must agree on standard
// output *and* on the exit status. That is the only test worth much for a shell: the behaviour is
// defined by what the real one does, and almost every rule has a case where the obvious
// implementation is subtly wrong.
//
// The scripts are restricted to what this shell implements — no globbing, no compound commands,
// and only the external programs in `program.wac`. Where ours cannot match bash the difference is
// in the README, rather than worked around by choosing kinder scripts.
//
// bash runs with `LC_ALL=C` so `sort` compares bytes, which is what ours does. Without it the
// locale decides and the two disagree on case.

const CASES: string[] = [
  // `head`/`tail` with the traditional count, which nothing here asked for until `head -2` was found
  // printing every line: a flag ignored rather than refused. GNU takes both spellings and so must this.
  "seq 1 5 | head -2",
  "seq 1 5 | head -n 2",
  "seq 1 5 | tail -2",
  "seq 1 5 | tail -n 2",
  "seq 1 5 | head",
  "seq 1 5 | head -0",
  "printf 'a\\nb\\nc\\n' | head -1",
  "printf 'a\\nb\\nc\\n' | tail -1",
  // ── Words and quoting ───────────────────────────────────────────────────────
  `echo hello`,
  `echo hello world`,
  `echo    spaced     out`,
  `echo "double quoted"`,
  `echo 'single quoted'`,
  `echo "a b"c'd e'`,
  `echo a"b"c`,
  `echo ""`,
  `echo`,
  `echo a\\ b`,
  `echo "it's"`,
  `echo 'say "hi"'`,
  `echo 'no $expansion here'`,
  `echo a#b`,
  `echo a # a comment`,
  `# just a comment`,

  // ── Parameters ──────────────────────────────────────────────────────────────
  `x=5; echo $x`,
  `x=5; echo \${x}`,
  `x=5; echo "$x"`,
  `x=hello; echo \${x}world`,
  `echo $undefined_variable`,
  `echo "$undefined_variable"`,
  `echo [$undefined_variable]`,
  `x="a b c"; echo $x`,
  `x="a b c"; echo "$x"`,
  `x="  spaced  "; echo "$x"`,
  `x=""; echo [$x]`,
  `x=""; echo ["$x"]`,
  `x=1; x=2; echo $x`,
  `x=a; y=$x; echo $y`,
  `echo $?`,
  `false; echo $?`,
  `true; echo $?`,

  // ── Exit status and lists ───────────────────────────────────────────────────
  `true && echo yes`,
  `false && echo no`,
  `false || echo yes`,
  `true || echo no`,
  `true && echo a && echo b`,
  `false || echo a || echo b`,
  `true && false; echo $?`,
  `echo a; echo b; echo c`,
  `false; true; echo $?`,

  // ── Pipelines ───────────────────────────────────────────────────────────────
  `echo hello | rev`,
  `echo hello | wc -l`,
  `seq 1 5 | wc -l`,
  // `seq`'s three-argument form, which was **read and thrown away**: `seq 1 2 9` printed `1 2`,
  // taking the first two operands as first and last and ignoring the increment. It went unnoticed
  // because `seq` is what the other cases here use to *make* input, so nobody asked it a question.
  `seq 1 2 9`,
  `seq 10 5 30`,
  `seq 5 -1 1`,
  `seq -1 1`,
  `seq -3 -1 -6`,
  `seq 1 -1 5`,
  `seq 3 1`,
  `seq 0`,
  `seq 1 1 1`,
  // …and what it says about what it will not do. Statuses are GNU's: 1 for every usage error.
  `seq; echo status=$?`,
  `seq abc; echo status=$?`,
  `seq 1 2 3 4; echo status=$?`,
  `seq 1 0 3; echo status=$?`,
  `seq 1 2 x; echo status=$?`,
  `seq -q 1; echo status=$?`,
  `seq -- 3`,
  // **`nl` numbered blank lines**, which GNU does not (its default body type is `t`), so every input
  // with a blank line in it came out with different numbers from that point on. An unnumbered line is
  // padded to the same width — seven spaces, because GNU pads by the number width plus the length of
  // the separator rather than printing the separator.
  String.raw`printf 'x\n\ny\n' | nl`,
  String.raw`printf '\n\n\n' | nl`,
  String.raw`printf 'a\n\nb\n\n\nc\n' | nl`,
  // Each of these tools has its own answer about a last line that arrived without a newline, and the
  // only way to know is to ask: `rev` leaves it off, `nl`, `uniq`, `sort` and `grep` put one on.
  String.raw`printf 'ab' | rev`,
  String.raw`printf 'x' | nl`,
  String.raw`printf 'x' | uniq`,
  String.raw`printf 'b\na' | sort`,
  String.raw`printf 'x' | grep x`,
  // …and its own answer about `-`. `cat`, `nl`, `uniq` and `sort` read standard input for it; GNU's
  // `rev` treats it as a filename and cannot open it.
  `printf 'ab\n' | rev -; echo status=$?`,
  `printf 'a\na\n' | uniq -`,
  `printf 'b\na\n' | sort -`,
  // `grep -q` answers on the first match rather than reading the rest, which is the only thing that
  // can stop the stage feeding it: nothing is written, so a refused write never happens.
  `seq 1 100000 | grep -q 5; echo status=$?`,
  `seq 1 100000 | grep -q zzz; echo status=$?`,
  // `cat` as a filter and as a refuser. `cat -Q` used to report "cat: -Q: No such file or directory",
  // which blames whoever typed it for a mistake this program made.
  `seq 1 3 | cat`,
  `printf 'a\nb\n' | cat -`,
  `echo x | cat -Q; echo status=$?`,
  // …and `cat`'s nine flags, which were filenames until now. Each is a line transform and GNU's
  // layout for each is exact, so every one of these is comparable rather than approximate.
  `printf 'a\n\n\n\nb\tc\n' | cat -n`,
  `printf 'a\n\n\n\nb\tc\n' | cat -b`,
  `printf 'a\n\n\n\nb\tc\n' | cat -s`,
  `printf 'a\n\n\n\nb\tc\n' | cat -ns`,
  `printf 'a\n\n\n\nb\tc\n' | cat -bs`,
  `printf 'a\n\n\n\nb\tc\n' | cat -E`,
  `printf 'a\n\n\n\nb\tc\n' | cat -T`,
  `printf 'a\n\n\n\nb\tc\n' | cat -A`,
  `printf 'a\n\n\n\nb\tc\n' | cat -e`,
  `printf 'a\n\n\n\nb\tc\n' | cat -t`,
  `printf 'a\n\n\n\nb\tc\n' | cat -u`,
  String.raw`printf 'a\001b\n' | cat -v`,
  String.raw`printf 'a\001b\n' | cat -vE`,
  String.raw`printf 'a\177b\n' | cat -v`,
  // A last line with no newline: `-E`'s `$` marks the newline, so it does not get one, and `-b`
  // still numbers it. Both were wrong in the first version of this.
  `printf 'x' | cat -A`,
  `printf 'x' | cat -n`,
  `printf 'x' | cat -b`,
  // More than one count, which GNU right-aligns in columns seven wide when it cannot know the size
  // of its input in advance. Every `wc` case here asked for a single count until this one, and every
  // `wc` case with a file was small enough that GNU's width was 1 — so a `wc` that printed one space
  // between counts agreed with bash on all of them and with none of these.
  `printf 'a b\nc\n' | wc`,
  `echo hi | wc -lwc`,
  `printf 'a\n' | wc -lc`,
  `seq 1 5 | wc -lw`,
  `seq 1 5 | head -n 2`,
  `seq 1 5 | tail -n 2`,
  `seq 1 10 | grep 1`,
  `seq 1 3 | nl`,
  `echo one two three | tr ' ' ','`,
  // `tr`'s flags, its escapes and its character classes — none of which it had. `tr -d 12` used to
  // read `-d` as a *set* and translate, `tr : '\n'` produced a backslash and an `n`, and
  // `[:digit:]` was eight literal characters. Every one of those reported success.
  `printf 'a1b2\n' | tr -d 12`,
  `printf 'a\nb\n' | tr -d '\n'; echo END`,
  `printf 'a  b\n' | tr -s ' '`,
  `printf 'ab\n' | tr -s 'ab' 'x'`,
  `printf 'aabb\n' | tr -ds a b`,
  `printf 'a1b2\n' | tr -c 'a-z' '.'`,
  `printf 'a1b2\n' | tr -c 'a-z' 'xy'`,
  `printf 'a1b2\n' | tr -cd 'a-z'; echo`,
  `printf 'a1b\n' | tr -cs 'a-z' 'xy'`,
  `printf 'abc\n' | tr -t 'abc' 'xy'`,
  `printf 'abc\n' | tr -ts 'abc' 'x'`,
  `printf 'a:b:c\n' | tr ':' '\n'`,
  `printf 'a\tb\n' | tr '\t' ':'`,
  `printf 'abc\n' | tr 'a\\142c' xyz`,
  `printf 'q\n' | tr '\\q' X`,
  `printf 'x\n' | tr '\\x41' X`,
  `printf 'a1b\n' | tr '[:digit:]' 'x'`,
  `printf 'ABC\n' | tr '[:upper:]' '[:lower:]'`,
  `printf 'a1\n' | tr '[:alnum:]' 'x'`,
  `printf 'a b\n' | tr '[:blank:]' '_'`,
  `printf 'a.b\n' | tr '[:punct:]' '_'`,
  `printf 'aFb\n' | tr '[:xdigit:]' '_'`,
  `printf 'a  b\n' | tr -s '[:space:]' ' '`,
  `printf 'a-d\n' | tr -- -d x`,
  `printf 'ab\n' | tr '' ''; echo status=$?`,
  `printf 'ab\n' | tr -d ''; echo status=$?`,
  `printf 'aab\n' | tr -s '' 'x'; echo status=$?`,
  `printf 'ab\n' | tr 'abc' 'xy'`,
  `printf 'abc\n' | tr 'ab' 'xyz'`,
  // The usage errors, which are GNU's own status 1 rather than a shell's 2. Only stdout and the
  // status are compared here, which is what makes them comparable at all: GNU adds a second line of
  // advice to stderr that this does not.
  `printf 'abc\n' | tr -q a b; echo status=$?`,
  `printf 'ab\n' | tr -d; echo status=$?`,
  `printf 'ab\n' | tr -d a b; echo status=$?`,
  `printf 'ab\n' | tr a; echo status=$?`,
  `printf 'ab\n' | tr 'z-a' 'x'; echo status=$?`,
  `printf 'ab\n' | tr a ''; echo status=$?`,
  `printf 'ab\n' | tr '[:nope:]' 'x'; echo status=$?`,
  // `[c*n]` and `[=c=]`, which were refused for one afternoon and are answers now. The repeat pads set2
  // out to set1's length when its count is empty or zero, is octal when it has a leading zero, and may
  // not appear in set1 at all — every one of those is GNU's rule, and every one of them is a case here.
  `printf 'abc\n' | tr abc '[x*]'`,
  `printf 'abcde\n' | tr abcde 'xy[z*]'`,
  `printf 'abc\n' | tr abc '[x*2]y'`,
  `printf 'abc\n' | tr abc '[x*0]y'`,
  `printf 'abc\n' | tr abc '[x*5]'`,
  `printf 'abcdefghij\n' | tr 'abcdefghij' '[x*010]y'`,
  `printf 'abc\n' | tr '[a*2]c' xyz`,
  `printf 'ab\n' | tr 'a[b*2]' 'xy'`,
  `printf 'abc\n' | tr abc '[*3]'`,
  `printf 'ab\n' | tr '[a*]' x; echo status=$?`,
  `printf 'ab\n' | tr 'a[x*]' y; echo status=$?`,
  `printf 'abc\n' | tr abc '[x*a]'; echo status=$?`,
  `printf 'ab\n' | tr 'a[b*c]d' x; echo status=$?`,
  `printf 'ab\n' | tr 'a[x*' y; echo status=$?`,
  `printf 'ab\n' | tr '[=a=]' x`,
  `printf 'abc\n' | tr 'a[=b=]c' xyz`,
  `printf 'ab\n' | tr '[=ab=]' x; echo status=$?`,
  `printf ',-.x\n' | tr '[:punct:]' '_'`,
  `printf 'a-b\n' | tr 'a\\-b' xyz`,
  `echo abc | tr abc xyz`,
  `seq 1 5 | sort -r`,
  `seq 3 1 | sort`,
  `echo hello | rev | rev`,
  `seq 1 100 | wc -l`,
  `seq 1 5 | grep -v 3 | wc -l`,
  `echo aaa | grep b`,
  `echo aaa | grep b; echo $?`,
  `echo aaa | grep a; echo $?`,
  `printf_not_a_command`,

  // ── test ────────────────────────────────────────────────────────────────────
  `test a = a && echo same`,
  `test a = b || echo different`,
  `test -z "" && echo empty`,
  `test -n x && echo nonempty`,
  `test 3 -gt 2 && echo bigger`,
  `test 2 -gt 3 || echo smaller`,
  `[ a = a ] && echo bracket`,
  `x=5; [ "$x" -eq 5 ] && echo five`,

  // ── Command substitution ────────────────────────────────────────────────────
  `echo $(echo nested)`,
  `echo "$(echo nested)"`,
  `x=$(echo value); echo $x`,
  `echo $(seq 1 3)`,
  `echo "$(seq 1 3)"`,
  `echo a$(echo b)c`,
  `echo $(echo a b c | wc -l)`,

  // ── Compound commands ───────────────────────────────────────────────────────
  //
  // Every loop here must terminate, because bash runs these too and a runaway would hang the
  // suite rather than fail it. Ours has a bound; bash does not.
  `if true; then echo yes; fi`,
  `if false; then echo no; fi`,
  `if false; then echo no; else echo fallback; fi`,
  `if false; then echo a; elif true; then echo b; else echo c; fi`,
  `if false; then echo a; elif false; then echo b; else echo c; fi`,
  `if true; then echo a; elif true; then echo b; fi`,
  `if echo cond; then echo body; fi`,
  `if false; then echo no; fi; echo $?`,
  `if true; then false; fi; echo $?`,
  `if
true
then
echo multiline
fi`,
  `for x in a b c; do echo $x; done`,
  `for x in a b c; do echo -n $x; done; echo`,
  `for x in; do echo $x; done; echo empty`,
  `for x in 1 2 3; do echo $x; done | wc -l`,
  `for f in one two; do echo "[$f]"; done`,
  `x=outer; for x in a; do echo $x; done; echo $x`,
  `for x in $(seq 1 3); do echo n$x; done`,
  `for x in a b; do for y in 1 2; do echo $x$y; done; done`,
  `x=1; while test $x -lt 4; do echo $x; x=$(seq $x $x | tr 123 234); done`,
  `while false; do echo never; done; echo done`,
  `x=1; until test $x -gt 2; do echo n$x; x=3; done`,
  `until true; do echo never; done; echo after`,
  `{ echo a; echo b; }`,
  `{ echo a; echo b; } | rev`,
  `{ echo a; } && echo ok`,
  `for x in a b; do if test $x = b; then echo found; fi; done`,
  `if true; then for x in 1 2; do echo $x; done; fi`,
  `if test -z ""; then echo empty; fi`,
  `echo if`,
  `echo done`,
  `echo "if true"`,

  // ── case ────────────────────────────────────────────────────────────────────
  `case a in a) echo hit;; esac`,
  `case b in a) echo no;; b) echo yes;; esac`,
  `case x in a|b|x) echo alt;; esac`,
  `case foo.txt in *.txt) echo text;; esac`,
  `case foo.log in *.txt) echo text;; *) echo other;; esac`,
  `case foo in *) echo default;; esac`,
  `case foo in a) echo no;; esac`,
  `case foo in a) echo no;; esac; echo $?`,
  `case abc in a?c) echo q;; esac`,
  `case "a b" in "a b") echo quoted;; esac`,
  `case a in (a) echo parens;; esac`,
  `x=b; case $x in b) echo expanded;; esac`,
  `case a in a) echo one; echo two;; esac`,
  `case a in b) echo no;; a) echo yes;; esac`,
  `case a in a) ;; esac; echo $?`,
  `case '*' in "*") echo literal;; esac`,
  `case x in
  a) echo a ;;
  x) echo x ;;
esac`,

  // ── Functions ───────────────────────────────────────────────────────────────
  `f() { echo in-function; }; f`,
  `f() { echo "got $1 and $2"; }; f a b`,
  `f() { echo $#; }; f a b c`,
  `f() { echo $#; }; f`,
  `greet() { echo hello $1; }; greet world; greet again`,
  `f() { echo "$@"; }; f a b c`,
  `f() { x=set-inside; }; f; echo $x`,
  `f() { echo $1; }; f one; echo "[$1]"`,
  `f() { false; }; f; echo $?`,
  `f() { true; }; f; echo $?`,
  `f() { echo a; }; f | rev`,
  `f() { seq 1 3; }; f | wc -l`,
  `outer() { inner; }; inner() { echo nested; }; outer`,
  `f() { echo defined; }; echo before; f`,
  `f() { if test "$1" = x; then echo isx; else echo notx; fi; }; f x; f y`,

  // ── Subshells ───────────────────────────────────────────────────────────────
  `(echo a)`,
  `(echo a; echo b)`,
  `x=1; (x=2; echo inside $x); echo outside $x`,
  `(exit 3); echo $?`,
  `(echo sub) | rev`,
  `(true) && echo ok`,
  `(false) || echo ko`,
  `(seq 1 3) | wc -l`,
  `f() { echo fn; }; (f); f`,
  `(cd_does_not_exist) 2>/dev/null; echo $?`,
  `echo $( (echo nested) )`,

  // ── Prefix assignments are scoped to their command ──────────────────────────
  `x=outer; x=inner true; echo $x`,
  `x=inner true; echo [$x]`,
  `x=1; x=2 true; echo $x`,
  `x=a y=b true; echo [$x][$y]`,
  `x=1; x=2 echo hello; echo $x`,
  `x=1; echo $x`,

  // ── Parameter expansion ─────────────────────────────────────────────────────
  //
  // The colon is the whole point: `\${x-w}` substitutes only when x is unset, `\${x:-w}` also
  // when it is set but empty. Every pair below is there to hold that apart.
  `echo \${undefined:-fallback}`,
  `x=set; echo \${x:-fallback}`,
  `x=; echo \${x:-fallback}`,
  `x=; echo \${x-fallback}`,
  `echo \${undefined-fallback}`,
  `x=v; echo \${x:+yes}`,
  `x=; echo \${x:+yes}`,
  `x=; echo \${x+yes}`,
  `echo \${undefined:+yes}`,
  `echo \${undefined+yes}`,
  `echo \${undefined:=assigned}; echo $undefined`,
  `x=keep; echo \${x:=assigned}; echo $x`,
  `echo \${#undefined}`,
  `x=hello; echo \${#x}`,
  `x=; echo \${#x}`,
  `y=inner; echo \${x:-$y}`,
  `y=inner; echo \${x:-\${y}}`,
  `echo \${x:-a b}`,
  `echo "\${x:-a b}"`,
  `x=1; echo "\${x:-no}"`,
  `echo \${x:?}`,
  `echo \${x:?custom message}`,
  `x=ok; echo \${x:?msg}`,
  `echo before; echo \${x:?stop}; echo after`,
  `f() { echo \${1:-default}; }; f; f given`,
  `f() { echo \${#}; }; f a b`,
  `echo \${x}`,
  `x=v; echo \${x}tail`,

  // ── Arithmetic ──────────────────────────────────────────────────────────────
  //
  // Two conventions a few characters apart: `$((a<b))` yields 1 for true, while `test a -lt b`
  // succeeds with status 0. Both appear below deliberately.
  `echo $((1+2))`,
  `echo $((10-3*2))`,
  `echo $(( (1+2)*3 ))`,
  `echo $((2*3+4*5))`,
  `echo $((7/2)) $((7%2))`,
  `echo $((-5+2))`,
  `echo $((- 5))`,
  `echo $((+3))`,
  `x=5; echo $((x+1))`,
  `x=5; echo $(($x+1))`,
  `x=5; echo $((\${x}+1))`,
  `echo $((undefined+1))`,
  `x=notanumber; echo $((x+1))`,
  `x=1+2; echo $((x))`,
  `echo $((3>2)) $((2>3)) $((2>=2)) $((2<=1))`,
  `echo $((1==1)) $((1!=1))`,
  `echo $((1&&0)) $((1||0)) $((!0)) $((!5))`,
  `echo $(( ))`,
  `echo $((0))`,
  `echo $((1/0))`,
  `echo $((1/0)); echo after`,
  `echo $((7%0))`,
  `echo $((1+))`,
  `echo $((a b))`,
  `x=$((1/0)); echo [$x]`,
  `i=1; while test $i -le 5; do echo $i; i=$((i+1)); done`,
  `n=0; for x in a b c; do n=$((n+1)); done; echo $n`,
  `i=0; until test $i -ge 3; do i=$((i+1)); done; echo $i`,
  `sum=0; for n in 1 2 3 4; do sum=$((sum+n)); done; echo $sum`,
  `x=10; if test $((x%2)) -eq 0; then echo even; fi`,
  `x=y; y=5; echo $((x))`,
  `a=b; b=c; c=7; echo $((a))`,
  `x=x; echo $((x))`,
  `a=b; b=a; echo $((a))`,
  `x=abc; echo $((x))`,
  `x=' 9 '; echo $((x))`,
  `echo $(echo not-arithmetic)`,
  `echo $( (echo subshell) )`,

  // ── Trimming a prefix or suffix ─────────────────────────────────────────────
  //
  // `#` and `%` strip a glob pattern off an end; doubled, they take the longest match. The
  // single/double pairs are here together because that is the only difference between them.
  `f=a.txt; echo \${f%.txt}`,
  `f=a.b.c; echo \${f%.*}`,
  `f=a.b.c; echo \${f%%.*}`,
  `p=/x/y/z; echo \${p##*/}`,
  `p=/x/y/z; echo \${p#*/}`,
  `p=/x/y/z; echo \${p%/*}`,
  `p=/x/y/z; echo \${p%%/*}`,
  `x=hello; echo \${x#h}`,
  `x=hello; echo \${x%o}`,
  `x=hello; echo \${x#nomatch}`,
  `x=hello; echo \${x%nomatch}`,
  `x=abc; echo \${x#?}`,
  `x=abc; echo \${x%%?}`,
  `x=aaa; echo \${x#a} \${x##a*}`,
  `y=b; x=abc; echo \${x#$y}`,
  `x=abc; echo \${x#a}\${x%c}`,
  `x=hello; echo \${#x}`,
  `x=; echo [\${x#a}]`,
  `echo [\${undefined#a}]`,

  // ── Bracket classes ─────────────────────────────────────────────────────────
  `case b in [abc]) echo hit;; esac`,
  `case d in [abc]) echo no;; *) echo miss;; esac`,
  `case q in [a-z]) echo lower;; esac`,
  `case Q in [a-z]) echo no;; *) echo other;; esac`,
  `case 5 in [0-9]) echo digit;; esac`,
  `case x in [!abc]) echo negated;; esac`,
  `case a in [!abc]) echo no;; *) echo in-set;; esac`,
  `case - in [a-]) echo dash;; esac`,
  `case a in []a]) echo bracket-first;; esac`,
  `echo [`,
  `echo []`,
  `x=a1; echo \${x#[a-z]}`,
  `x=a1; echo \${x%[0-9]}`,

  // ── Builtins ────────────────────────────────────────────────────────────────
  `echo -n no-newline`,
  `echo -n a; echo b`,
  `:`,
  `: ; echo $?`,
  `exit 3`,
  `echo before; exit 4; echo after`,
  `unset x; echo [$x]`,
  `x=1; unset x; echo [$x]`,

  // ── Case conversion, and the special parameters' set-ness ───────────────────
  //
  // The doubled forms do every character and the single ones only the *first* — `${x^b}` of `abc`
  // is unchanged rather than reaching forward to the `b`, which is a position and not a search.
  // The argument is a pattern selecting which characters are eligible, and an absent one matches
  // anything.
  "x=abc; echo [${x^}]",
  "x=Abc; echo [${x^}]",
  "x=abc; echo [${x^^}]",
  "x=ABC; echo [${x,}]",
  "x=aBC; echo [${x,}]",
  "x=ABC; echo [${x,,}]",
  "x=abc; echo [${x^a}]",
  "x=abc; echo [${x^b}]",
  "x=abc; echo [${x,c}]",
  "x=abc; echo [${x^^[ab]}]",
  "x=abc; echo [${x,,[AB]}]",
  "x=abc; echo [${x^^?}]",
  'x=""; echo [${x^}]',
  "x=a-b; echo [${x^^}]",
  // `$?` and `$#` always have a value; `$@` and `$*` do not when there are no parameters. And
  // `${#@}` counts them rather than measuring them joined, the one place `${#…}` is not a length.
  "echo [${?-x}]",
  "echo [${#-x}]",
  "echo [${@-x}]",
  "echo [${*-x}]",
  "set -- a; echo [${@-x}]",
  "set -- a; echo [${*-x}]",
  "set -- a b; echo [${#@}]",
  "set -- a b; echo [${#*}]",
  "echo [${#@}]",
  "set -- a; echo [${1-x}]",
  "set -- a; echo [${2-x}]",
  // An operator nothing implements is a bad substitution, not the value unchanged.
  "x=abc; echo [${x!}]; echo after",

  // ── Substrings ──────────────────────────────────────────────────────────────
  //
  // The only thing separating `${x:1:2}` from the `${x:-w}` family is what follows the colon,
  // which is why `${x:-1}` is a default of `-1` and `${x: -1}` is the last character. Both are
  // below, a space apart, because that is the whole difference and bash requires it for the same
  // reason we do.
  //
  // A negative offset that reaches past the start gives the empty string rather than clamping to
  // zero, and a negative *length* is a position rather than a count — which is why `${x:1:-1}` is
  // the idiom for dropping the last character.
  "x=abcdef; echo ${x:1:2}",
  "x=abcdef; echo ${x:2}",
  "x=abcdef; echo ${x:0:3}",
  "x=abcdef; echo ${x:0}",
  "x=abc; echo [${x::2}]",
  "x=abc; echo [${x:1:}]",
  "x=abcdef; echo ${x: -2}",
  "x=abc; echo [${x: -9}]",
  "x=abc; echo [${x:-9}]",
  "x=abcdef; echo ${x:1:-1}",
  "x=abc; echo ${x:9}",
  "x=abc; echo ${x:1:0}",
  "x=abc; echo [${x:1:9}]",
  "x=abc; echo [${x:abc}]",
  "x=abcdef; n=2; echo [${x:n}]",
  "x=abcdef; n=2; echo [${x:n:n}]",
  "x=abcdef; n=2; echo [${x:$n}]",
  "x=abcdef; echo [${x:1+1}]",
  "x=abcdef; a=1; b=3; echo [${x:a+b}]",
  "x=abcdef; echo [${x:$((1+1)):2}]",
  "set -- a b c; echo [${1:0:1}]",
  "f=name.tar.gz; echo ${f:0:4}${f: -3}",
  // A bad substitution is fatal: nothing printed, exit 1, and the rest of the line abandoned.
  "x=abc; echo [${x:}]; echo after",
  "x=abc; echo [${x:1:-9}]; echo after",
  "x=abc; echo ${#x:1}; echo after",

  // ── printf, which has a language of its own ──────────────────────────────────
  //
  // The three rules that are not guessable: the format is *reused* until the arguments run out, a
  // missing argument is not an error, and a bad *number* is reported and then used as zero anyway
  // while a bad *format* aborts. That last pair is the one worth having cases for — bash prints
  // the `ab` of `printf "ab%z"` before giving up, so it is an abort and not a discard.
  String.raw`printf "hi\n"`,
  `printf hi`,
  String.raw`printf "%s\n" a b c`,
  String.raw`printf "%s-%s\n" a b c d`,
  String.raw`printf "%s-%s\n" a`,
  String.raw`printf "%d %d\n" 1`,
  String.raw`printf "no args %s|\n"`,
  String.raw`printf "%s\n" ""`,
  `printf ""`,
  `printf "%s"`,
  `printf`,
  String.raw`printf "%d\n" 42`,
  String.raw`printf "%d\n" -42`,
  String.raw`printf "%d\n" abc`,
  String.raw`printf "%5s|\n" ab`,
  String.raw`printf "%-5s|\n" ab`,
  String.raw`printf "%03d\n" 7`,
  String.raw`printf "%03d\n" -7`,
  String.raw`printf "%.2s|\n" abcdef`,
  String.raw`printf "%x %X %o\n" 255 255 8`,
  String.raw`printf "%c" abc`,
  String.raw`printf "%%\n"`,
  String.raw`printf "a\tb\n"`,
  String.raw`printf "\x41\n"`,
  String.raw`printf "\x4a\n"`,
  String.raw`printf "\x4A\n"`,
  String.raw`printf "\xZ\n"`,
  String.raw`printf "%x\n" abc`,
  String.raw`printf "\101\n"`,
  String.raw`printf "a\qb\n"`,
  // A bad format aborts, keeping what came before it.
  String.raw`printf "%z\n" x`,
  `printf "%"`,
  `printf "ab%"`,
  String.raw`printf "ab%z\n" x`,
  `printf "%s%z" a b`,
  // And it composes, which is why it was worth having: input with no trailing newline.
  String.raw`printf "%s\n" a | wc -l`,
  String.raw`printf "a\nb\n" | rev`,
  String.raw`printf "b\na\nb\n" | sort | uniq`,
  String.raw`printf "one two\n" | { read a b; echo "[$a][$b]"; }`,
  String.raw`printf "no-newline" | { read x; echo "[$x]" $?; }`,

  // ── Pattern substitution ────────────────────────────────────────────────────
  //
  // Three things here are not guessable from the shorter forms, and each has a pair below:
  // `#`/`%` right after the slash anchor the match rather than saying which end to trim; `&` in
  // the replacement is the text that matched, and `\&` is a literal one, which bash grew in 5.2;
  // and an empty match does not substitute, so `${x//""/-}` leaves the value alone rather than
  // inserting between every character.
  "x=abcabc; echo ${x/b/Z}",
  "x=abcabc; echo ${x//b/Z}",
  "x=aaa; echo ${x/a*/X}",
  'x=abc; echo "${x/b*/Z}"',
  "x=abc; echo ${x//*/X}",
  "x=abc; echo ${x/#a/Z}",
  "x=abc; echo ${x/#b/Z}",
  "x=abc; echo ${x/%c/Z}",
  "x=abc; echo ${x/%a/Z}",
  "x=abc; echo ${x/b}",
  "x=abc; echo ${x/c/}",
  "x=abc; echo ${x//}",
  'x=abc; echo "${x//""/-}"',
  "x=; echo [${x/a/b}]",
  "x=aaa; echo ${x//a/}",
  "x=aXbXc; echo ${x//X/}",
  "x=a.b; echo ${x/./X}",
  "x=abc; echo ${x/?/X}",
  "x=abc; echo ${x/[ab]/Z}",
  "x=abc; echo ${x//[ab]/Z}",
  "x=a/b; echo ${x/\\//-}",
  "x=foo.txt; echo ${x/.txt/.md}",
  'x="a b"; echo "${x/ /_}"',
  'x="a b c"; echo "${x// /_}"',
  'x=abc; echo "${x//?/[&]}"',
  'x=abc; echo "${x/b/[&]}"',
  'x=abc; echo "${x/b/\\&}"',
  'x=abc; echo "${x/a/&&}"',
  'x=abc; echo "${x/b/&x&}"',
  "p=b; x=abc; echo ${x/$p/Z}",
  "r=Z; x=abc; echo ${x/b/$r}",
  "x=abc; echo ${x/b/$(echo Q)}",
  // A trim pattern is not split either, which was wrong in the same way until now.
  'x="a b"; echo "${x#a }"',
  'x="a b"; echo "${x%% b}"',
  'x=" lead"; echo "[${x# }]"',
  'x="trail "; echo "[${x% }]"',

  // ── tr, whose sets have their own small language ─────────────────────────────
  //
  // Ranges were missing entirely and `a-z` was the three-character set `{a, -, z}` — issue 0019,
  // which cost the agent who found it twenty minutes because `tr a-z A-Z` on `hello a` *does*
  // translate the `a`, so it looks like something happened. Everything below is here because the
  // real `tr` does something a reasonable implementation would not: a `-` that cannot begin a
  // range is literal, a descending range is an error rather than a literal set, and an empty
  // second set is an error rather than a pass-through.
  "echo hello | tr a-z A-Z",
  'echo "hello a" | tr a-z A-Z',
  "echo HELLO | tr A-Z a-z",
  "echo abcz | tr a-c 1-3",
  "echo 5 | tr 0-9 a-j",
  "echo hi | tr h-i H-I",
  "echo abc | tr ab xy",
  "echo abc | tr abc x",
  "echo abc | tr a- X",
  "echo a-c | tr -- - _",
  'echo abc | tr z-a X',
  'echo abc | tr a-c ""',
  'echo abc | tr "" X',
  "echo x | tr",
  "echo x | tr a",
  "echo hello world | tr a-z A-Z | rev",
  "echo x-y | tr x-y a-c",

  // ── read, set and shift ─────────────────────────────────────────────────────
  //
  // `read` is the only builtin that *consumes* standard input, so most of these are about the
  // cursor: what the next read sees, and whether a loop over it ends. It ends because `read`
  // fails when the line was not terminated by a newline — which also means bash drops the last
  // line of input that has no newline, and so do we.
  "echo x | { read a; echo [$a]; }",
  "echo a b c | { read x y z; echo \"$x|$y|$z\"; }",
  "echo a b c d | { read x y; echo \"$x|$y\"; }",
  "echo a b | { read x; echo [$x]; }",
  'echo "  a  b  " | { read x y; echo "[$x][$y]"; }',
  "seq 1 2 | { read a; read b; echo \"$a-$b\"; }",
  "seq 1 2 | { read a; read b; read c; echo $?; }",
  "echo x | { read a; echo $?; }",
  "echo | { read x; echo \"[$x]\" $?; }",
  "echo -n ab | { read x; echo [$x] $?; }",
  "echo hi | { read; echo [$REPLY]; }",
  "seq 1 3 | while read x; do echo n$x; done",
  "echo -n ab | while read x; do echo [$x]; done",
  "seq 1 3 | while read x; do echo $x; done | wc -l",
  "seq 1 4 | while read a b; do echo \"$a/$b\"; done",
  "seq 1 3 | { read a; while read x; do echo w$x; done; }",
  "while read x; do echo [$x]; done <<EOF\np\nq\nEOF",
  "{ read a; cat; } <<EOF\none\ntwo\nthree\nEOF",
  "read x < /dev/null; echo $?",
  "echo '\\tt' | { read a b; echo \"[$a][$b]\"; }",
  "echo 'a\\ b' | { read x y; echo \"[$x][$y]\"; }",
  "echo 'a\\ b' | { read -r x y; echo \"[$x][$y]\"; }",
  "echo 'a\\ b c' | { read x y; echo \"[$x][$y]\"; }",
  "echo 'a\\\\b' | { read x; echo [$x]; }",
  // The positional parameters, which until now nothing could change.
  "set -- a b c; echo $# $1 $3",
  "set a b c; echo \"$@\"",
  "set -- a b c; shift; echo \"$@\"",
  "set -- a b c; shift 2; echo \"$@\"",
  "set -- a; shift 2; echo $?",
  "set -- a; shift 2; echo \"$@\"",
  "set --; echo [$#]",
  "set -- a b c; while test $# -gt 0; do echo $1; shift; done",
  "f() { shift; echo \"$@\"; }; f 1 2 3",
  "set -- x; f() { set -- y; echo $1; }; f; echo $1",
  "set -- a b; echo \"$*\"",
  "shift; echo $?",

  // ── Backquotes ──────────────────────────────────────────────────────────────
  //
  // The same thing as `$(…)` once it is a part, so these are about the reading: where it ends,
  // and the backslash rules inside, which are its own and not the ones outside it.
  "echo `echo hi`",
  "echo a`echo b`c",
  'echo "`echo hi`"',
  "echo '`echo hi`'",
  "x=`echo v`; echo $x",
  "echo `seq 1 3`",
  'echo "`seq 1 3`"',
  "echo `echo a; echo b`",
  "echo `echo one two` | wc -w",
  "echo ``",
  "echo `",
  "echo `false`; echo $?",
  "if `true`; then echo y; fi",
  "echo $(echo `echo inner`)",
  "echo `echo $(echo inner)`",
  "echo `echo \\`nested\\``",
  'echo "\\`not a sub\\`"',
  "echo `echo \\$x`",
  "cat <<EOF\n`echo from-heredoc`\nEOF",

  // ── The status of a command with no command name ────────────────────────────
  //
  // POSIX: it is the status of the *last command substitution*, or zero if there was none. So
  // `x=$(false)` reports 1 where a bare `x=1` reports 0, and the two are a character apart.
  "x=$(false); echo $?",
  "x=$(exit 3); echo $?",
  "x=$(true); echo $?",
  "x=1; echo $?",
  "false; x=1; echo $?",
  "$(exit 3); echo $?",
  "a=$(true) b=$(false); echo $?",
  "a=$(false) b=$(true); echo $?",
  "echo $(exit 3)$?",
  "echo `exit 3`$?",
  "x=$(echo v; exit 3); echo $x $?",
  "echo before; x=$(exit 5); echo after $?",

  // ── Here-documents ──────────────────────────────────────────────────────────
  //
  // The only construct where a token's meaning depends on the *following* lines, so most of
  // these are about where the body starts and stops rather than about what it contains.
  //
  // Quoting the delimiter — in any of its three spellings — turns expansion off for the whole
  // body. That is the one thing here that is easy to get subtly wrong, so all three appear.
  `cat <<EOF\nhello\nEOF`,
  `cat <<EOF\none\ntwo\nEOF`,
  `cat <<EOF\nEOF`,
  `x=world; cat <<EOF\nhello $x\nEOF`,
  `x=world; cat <<'EOF'\nhello $x\nEOF`,
  `x=world; cat <<"EOF"\nhello $x\nEOF`,
  `x=world; cat <<\\EOF\nhello $x\nEOF`,
  `x=world; cat <<E"O"F\nhello $x\nEOF`,
  `cat <<EOF\n$(echo sub) and $((2 + 3))\nEOF`,
  `x=hi; cat <<EOF\n\\$x and "q"\nEOF`,
  // The delimiter is a whole line or it is body text.
  `cat <<EOF\nEOFX is not the end\nEOF`,
  `cat <<EOF\nxEOF is not the end\nEOF`,
  // `<<-` strips leading tabs from the body *and* from the closing delimiter, spaces never.
  `cat <<-EOF\n\ttabbed\n\tEOF`,
  `cat <<-EOF\n\t\tdouble\nnone\n\tEOF`,
  // Where it sits relative to everything else on the line.
  `cat <<EOF | rev\nabc\nEOF`,
  `cat <<EOF > /dev/null; echo done\nignored\nEOF`,
  `wc -l <<EOF\na\nb\nc\nEOF`,
  `echo before; cat <<EOF\nbody\nEOF\necho after`,
  `cat <<A <<B\nfirst\nA\nsecond\nB`,
  `cat <<A\nfirst\nA\ncat <<B\nsecond\nB`,
  `if true; then cat <<EOF\ninside\nEOF\nfi`,
  `for i in 1 2; do cat <<EOF\niter $i\nEOF\ndone`,
  `f() { cat <<EOF\nfrom a function\nEOF\n}; f; f`,
  `v=$(cat <<EOF\ncaptured\nEOF\n); echo "[$v]"`,
  // Bash warns on stderr about an unterminated body but still runs the command, exit 0.
  `cat <<EOF`,
  `cat <<EOF\nno terminator`,
];

/**
 * A directory to glob against, made once and used by the pattern cases below.
 *
 * Absolute paths here, so a pattern means the same thing to both shells wherever the suite is run
 * from. Relative ones are covered by the `cd` cases below, which move both shells first.
 */
const globDir = await Deno.makeTempDir();
/**
 * Remove what this file built, however it ends.
 *
 * `Deno.test` has no suite-level teardown, so a module-level temp used by several tests had nowhere to
 * be cleaned up and was left behind — one built binary of about 700 KiB per run of the suite. Five
 * hundred of them were sitting in `/tmp` when a parallel run finally died with "No space left on
 * device", in the middle of a package that had nothing to do with it. `unload` fires on the way out
 * whether the tests passed, failed or threw, which is the only hook that covers all three.
 */
globalThis.addEventListener("unload", () => {
  try {
    Deno.removeSync(globDir, { recursive: true });
  } catch {
    // Already gone, or never made. Nothing to report on the way out.
  }
});

for (const name of ["a.txt", "b.txt", "c.log", ".hidden"]) {
  await Deno.writeTextFile(`${globDir}/${name}`, "");
}
await Deno.mkdir(`${globDir}/sub`);
await Deno.writeTextFile(`${globDir}/sub/x.txt`, "");

for (const pattern of [
  "*.txt", "*", "?.log", "*.log", "nomatch*", "sub/*", "a?txt", "*.t?t", "sub/x.*",
]) {
  CASES.push(`echo ${globDir}/${pattern}`);
}
// Quoted patterns must not glob, and neither must a quoted metacharacter next to an unquoted one.
CASES.push(`echo "${globDir}/*.txt"`);
CASES.push(`echo '${globDir}/*.txt'`);
CASES.push(`echo ${globDir}/"*".txt`);
CASES.push(`x="${globDir}/*.txt"; echo "$x"`);

/**
 * `cd`, `pwd` and `ls`.
 *
 * The three things everybody types into a new shell, and the ones most able to be subtly wrong:
 * a `cd` that moves the prompt but not the next `cat` is worse than no `cd`. Every case moves
 * first and then does something that has to notice — read a file, glob, redirect, list.
 *
 * bash resolves these against the process's directory and this shell against its own idea of one,
 * which is exactly the thing under test: if the two disagree about where "here" is, the output
 * differs and the case fails.
 */
for (const script of [
  `cd ${globDir}; pwd`,
  `cd ${globDir}; cd sub; pwd`,
  `cd ${globDir}/sub; cd ..; pwd`,
  `cd ${globDir}; cd ./sub/../sub; pwd`,
  `cd /; pwd`,
  `cd /; cd ..; pwd`,                                  // `..` above the root stays at the root
  `cd ${globDir}; ls`,
  `cd ${globDir}; ls sub`,
  `cd ${globDir}; ls -a | sort`,                        // the dotfile shows only with -a
  `cd ${globDir}; ls nosuchthing; echo status=$?`,
  `cd ${globDir}; cat sub/x.txt; echo read=$?`,         // a relative read after moving
  `cd ${globDir}/sub; cat ../a.txt; echo read=$?`,      // ...and one through `..`
  `cd ${globDir}; echo ${"${globDir}"}/*.txt | tr " " "\n" | wc -l`,
  `cd ${globDir}; echo *.txt`,                          // a *relative* glob, resolved by cwd
  `cd ${globDir}/sub; echo *.txt`,
  `cd nosuchdir; echo status=$?`,                       // a failed cd changes nothing
  `cd ${globDir}; cd nosuchdir; pwd`,
  `cd ${globDir}; OLDPWD=; cd sub; cd - >/dev/null; pwd`,
]) {
  CASES.push(script);
}

/**
 * `mkdir` and `rm`.
 *
 * They are here because `cd` needs somewhere to go: in a browser the filesystem starts empty, so
 * a shell with `cd` and no `mkdir` looks broken when it is merely alone. Each case works in a
 * directory of its own, since these ones write.
 *
 * Only stdout and the exit status are compared: bash's `mkdir` is `/bin/mkdir` and its wording is
 * its own, so comparing the text of a refusal would be comparing two dialects. The *order* of the
 * two streams is compared, in its own test at the end of this file.
 */
for (const [i, script] of [
  `mkdir one; ls`,
  `mkdir -p one/two/three; ls one/two`,
  `mkdir one; mkdir one; echo status=$?`,
  `mkdir -p one; mkdir -p one; echo status=$?`,
  `mkdir one; echo hi > one/f; cat one/f`,
  `mkdir one; cd one; pwd`,
  `mkdir one; echo x > one/f; rm -r one; ls; echo status=$?`,
  `rm nothing; echo status=$?`,
  `rm -f nothing; echo status=$?`,
  `mkdir one; rm one; echo status=$?`,
  // `test`'s file operators, which need something to look at — the reason they are in this group and
  // not among the string tests above. `test -f f` was "unknown operator" until it was compared with
  // bash: the most ordinary line a script contains, answered with a usage error.
  `echo x > f; test -f f && echo isfile`,
  `echo x > f; test -d f || echo notdir`,
  `mkdir one; test -d one && echo isdir`,
  `mkdir one; test -f one || echo notfile`,
  `echo x > f; test -e f && echo exists`,
  `test -e nothing || echo absent`,
  `test -f nothing; echo status=$?`,
  `echo x > f; [ -f f ] && echo bracket`,
  `echo x > f; test ! -f f; echo status=$?`,
  `test ! -f nothing && echo missing`,
  `echo x > f; test -s f && echo nonempty`,
  `: > empty; test -s empty; echo status=$?`,
  `test -s nothing; echo status=$?`,
  `echo x > f; test -h f; echo status=$?`,       // not a link, and `stat` would have said "file"
  `test -q f; echo status=$?`,                   // still refused, and it is a *usage* error: 2
  // File *operands*. Every program here except `cat` used to ignore them and read standard input
  // regardless, so `wc -l f` printed `0` and exited `0`, and `grep pattern f` exited 1 — which a
  // script reads as "no match" rather than "the file was never opened".
  `printf 'a\nb\n' > f; wc -l f`,
  `printf 'a\nb\n' > f; wc f`,
  // A file big enough for the column width to be visible: GNU takes it from the digits of the total
  // size, so these are six wide where the two-line files above are one.
  `seq 1 20000 > f; wc f`,
  `seq 1 20000 > f; wc -l f`,
  `seq 1 20000 > f1; echo x > f2; wc f1 f2`,
  `seq 1 20000 > f1; echo x > f2; wc -lw f1 f2`,
  `printf 'a\nb\n' > f; wc -l < f`,             // and no name, when it is standard input
  `printf 'a\nb\n' > f; wc -l - < f`,           // …but `-` keeps its name, as GNU prints it
  `printf 'a\nb\n' > f; head -1 f`,
  `printf 'a\nb\n' > f; tail -1 f`,
  `printf 'b\na\n' > f; sort f`,
  `printf 'a\na\n' > f; uniq f`,
  `printf 'ab\n' > f; rev f`,
  `printf 'a\nb\n' > f; nl f`,
  `printf 'a\nb\n' > f; cat f - < f`,
  // Redirections, which used to gather the command's whole output in the shell and write the file
  // afterwards — so `seq 1 2000000000 > out` trapped at one wasm array where bash writes twenty
  // gigabytes (0070). The streaming path opens the file first and relays into it, which is why the
  // truncation, the ordering and the capture interaction all need saying.
  `seq 1 3 > f; cat f`,
  `seq 1 3 > f; seq 4 5 > f; cat f`,
  `seq 1 5 | head -2 > f; cat f`,
  `x=$(seq 1 3 > f); echo "[$x]"; cat f`,
  // **Truncated first, on purpose.** The harness gives each case a directory and runs *both* shells in
  // it, so a case whose answer depends on what is already there sees the other shell's leftovers: this
  // one without the `: > f` reported `1..5` from bash and `1..5` twice from us, which is the harness
  // rather than the shell. Every other case here happens to truncate, which is why nothing had hit it.
  `: > f; seq 1 3 >> f; seq 4 5 >> f; cat f`,
  `printf '' > f; wc -c < f`,
  `cat missing > f; echo status=$?; wc -c < f`,
  `seq 1 3 > sub/f; echo status=$?`,
  `echo one > f; echo two > f; wc -l < f`,
  // The operand paths of the five that now stream, including the two orderings of a file that cannot
  // be opened — `rev` and `nl` report and carry on, `sort` gives up, and the complaint lands *between*
  // the outputs rather than before them, which needs the output sink flushed first.
  `printf 'ab\n' > f1; printf 'cd\n' > f2; rev f1 f2`,
  `printf 'ab\n' > f; rev f missing; echo status=$?`,
  `printf 'a\nb\n' > f; nl f missing; echo status=$?`,
  `printf 'a\n\nb\n' > f1; printf '\nc\n' > f2; nl f1 f2`,
  `printf 'a\na\n' > f; uniq f`,
  `printf 'b\na\n' > f1; printf 'z\n' > f2; sort f1 f2`,
  `printf 'b\na\n' > f; sort - f < f`,
  // A file it cannot open is reported and the *rest are still printed*, as GNU does. This used to
  // stop at the first failure, so `cat missing f` printed the complaint and none of `f` — with the
  // right status, which is what made it invisible.
  `printf 'a\nb\n' > f; cat missing f; echo status=$?`,
  `printf 'a\nb\n' > f; cat f missing; echo status=$?`,
  `printf 'a\nb\n' > f1; printf 'c\n' > f2; cat f1 missing f2; echo status=$?`,
  `printf 'a\nb\n' > f; cat -n f; echo status=$?`,
  // Numbering and squeezing run across the operands, as GNU's do.
  `printf 'a\nb\n' > f1; printf 'c\n' > f2; cat -n f1 f2`,
  `printf 'a\n\n' > f1; printf '\nc\n' > f2; cat -s f1 f2`,
  `printf 'a\nb\n' > f; cat -n f - < f`,
  // Several of them, where the shape of the answer changes: `wc` names each file and totals them,
  // `head` and `tail` write a header per block, `grep` labels its lines, and `sort`, `nl` and `rev`
  // treat the operands as one concatenation — `nl`'s numbering runs on across the boundary.
  `printf 'a\nb\n' > f1; printf 'c\n' > f2; wc -l f1 f2`,
  `printf 'a\nb\n' > f1; printf 'c\n' > f2; wc f1 f2`,
  `printf 'a\nb\n' > f1; printf 'c\n' > f2; wc -c f1 f1`,
  `printf 'a\nb\n' > f1; printf 'c\n' > f2; head -1 f1 f2`,
  `printf 'a\nb\n' > f1; printf 'c\n' > f2; tail -n 1 f1 f2`,
  `printf 'a\nb\n' > f1; printf 'c\n' > f2; nl f1 f2`,
  `printf 'a\nb\n' > f1; printf 'c\n' > f2; sort f1 f2`,
  `printf 'ab\n' > f1; printf 'c\n' > f2; rev f1 f2`,
  // `grep`'s flags, which were not read at all: an option it did not have became the *pattern*, so
  // `grep -c a f` searched for `-c` and reported no match.
  `printf 'a\nb\n' > f; grep a f`,
  `printf 'a\nb\n' > f; grep -c a f`,
  `printf 'a\nb\n' > f; grep -n a f`,
  `printf 'a\nb\n' > f; grep -v a f`,
  `printf 'a\nb\n' > f; grep -cv a f`,
  `printf 'Apple\nbanana\napple\n' > f; grep -i apple f`,
  `printf 'Apple\nbanana\napple\n' > f; grep -in a f`,
  `printf 'Apple\napple\n' > f; grep -x apple f`,
  `printf 'a\nb\n' > f; grep -q a f; echo status=$?`,
  `printf 'a\nb\n' > f; grep -q z f; echo status=$?`,
  `printf 'a\nb\n' > f1; printf 'c\n' > f2; grep a f1 f2`,
  `printf 'a\nb\n' > f1; printf 'c\n' > f2; grep -c a f1 f2`,
  // A file that cannot be read: each of these has GNU's own status for it, and three of the four
  // concatenating programs carry on with what they could read where `sort` gives up.
  `grep a missing; echo status=$?`,
  `wc -l missing; echo status=$?`,
  `head -1 missing; echo status=$?`,
  `tail -1 missing; echo status=$?`,
  `sort missing; echo status=$?`,
  `uniq missing; echo status=$?`,
  `rev missing; echo status=$?`,
  `nl missing; echo status=$?`,
  `wc -l missing1 missing2; echo status=$?`,
  `printf 'c\n' > f2; nl missing f2; echo status=$?`,
  `printf 'c\n' > f2; rev missing f2; echo status=$?`,
  `printf 'c\n' > f2; sort missing f2; echo status=$?`,
  `printf 'c\n' > f2; grep c missing f2; echo status=$?`,
  `printf 'a\nb\n' > f; wc -l f missing; echo status=$?`,
  `printf 'a\nb\n' > f; head -1 f missing; echo status=$?`,
  // An option none of them has, refused rather than taken for something else. The statuses differ by
  // program and are GNU's: 1 for `wc`, `head`, `tail`, `uniq`, `nl` and `rev`; 2 for `sort` and `grep`.
  `echo x | wc -Z; echo status=$?`,
  `echo x | sort -Z; echo status=$?`,
  `echo x | grep -Y x; echo status=$?`,
  `echo x | uniq -Z; echo status=$?`,
  `echo x | head -Z; echo status=$?`,
  `echo x | tail -Z; echo status=$?`,
  `echo x | nl -Z; echo status=$?`,
  `echo x | rev -Z; echo status=$?`,
].entries()) {
  // A directory per case, made by the harness rather than the script, so one failure cannot
  // leave a mess that changes what the next case sees.
  const dir = `${globDir}/w${i}`;
  Deno.mkdirSync(dir);
  CASES.push(`cd ${dir}; ${script}`);
}

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` \u2014 ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

async function bash(script: string) {
  const r = await new Deno.Command("bash", {
    args: ["-c", script],
    // No standard input for either shell, and said rather than inherited. A script that reads — `cat`
    // or `read` with nothing redirected into it — now reads the *shell's* input, since `sh` claims it
    // (issue 0032). Inheriting the test runner's would mean both shells waiting on a terminal that
    // never ends, which is a hang rather than a difference.
    stdin: "null",
    env: { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
    clearEnv: true,
  }).output();
  return { stdout: new TextDecoder().decode(r.stdout), code: r.code };
}

/**
 * The shell, built once as a standalone program.
 *
 * Not `deno task app` per script: that builds every time *and* spawns the result as a child, so a
 * hundred and thirty scripts become several hundred nested processes. This container ran out of
 * process ids once already today for a related reason — see wac-mono 0017 — and the build is the
 * slow part regardless.
 */
/**
 * Remove the built shell however this file ends.
 *
 * `Deno.test` has no suite-level teardown, so a module-level temp had nowhere to be cleaned up: 98 of
 * these were sitting in `/tmp` — one 400 KiB shell per run of the suite, since March by the timestamps —
 * and the same leak in `spawn.test.ts` is what filled the disk once already today. `unload` fires
 * whether the tests passed, failed or threw, which is the only hook that covers all three.
 */
const GRANTS = { read: true, write: true, env: true };

/**
 * The shell as an executable, for the tests that need a real process: one redirects both streams
 * into a file through bash, one feeds a script on standard input, and one compares what two
 * *processes* see of `HOME` and `OLDPWD`.
 */
const wacshBinary = await (async () => {
  const out = await Deno.makeTempFile({ prefix: "wacsh-" });
  globalThis.addEventListener("unload", () => {
    try {
      Deno.removeSync(out);
    } catch {
      // Already gone, or never built. Nothing to report on the way out.
    }
  });
  // `buildApp` directly rather than `deno run build.ts` — a whole extra Deno start for a function
  // this file can import.
  await buildApp("packages/sh/src/sh.wac", out, GRANTS);
  return out;
})();

/**
 * The shell in *this* process, which is how the 604 cases run.
 *
 * Each case was two subprocesses and one of them was ours at ~167ms, which was most of what this
 * file cost. `appRunner` is the launcher half of a built program, so a case is a worker here — same
 * wasm, same world, no second Deno. bash stays a process: it is the oracle at 2.5ms, and running it
 * any other way would be testing something else.
 */
const sh = await appRunner("packages/sh/src/sh.wac", GRANTS);

/**
 * The environment the shell is given.
 *
 * The spawning version passed three variables with `clearEnv: false`, so it *inherited* the suite's
 * environment and overrode those. `appRunner`'s `env` is exhaustive, so the inheritance is spelled
 * out rather than quietly dropped — a variable the suite had and this did not would be a difference
 * between the two shells that nothing here would attribute correctly.
 */
const SH_ENV: Record<string, string> = {
  ...Deno.env.toObject(),
  LC_ALL: "C",
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  HOME: Deno.env.get("HOME") ?? "",
};

async function wacsh(script: string) {
  // No standard input, as for bash above: the comparison is of scripts, not of terminals. The
  // runner ends the input stream at once when none is given, which is what `stdin: "null"` did.
  const r = await sh.run(["-c", script], { env: SH_ENV });
  return { stdout: r.out, code: r.code, stderr: r.err };
}

const haveBash = await (async () => {
  try {
    return (await new Deno.Command("bash", { args: ["-c", "exit 0"] }).output()).code === 0;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "every script agrees with bash on output and exit status",
  ignore: !haveBash,
  fn: async () => {
    // Four at a time. Each script is a bash subprocess and an in-process run of our shell, so serially this
    // is twenty-odd seconds of a suite that runs in a minute.
    //
    // Through `pool` rather than a hand-rolled queue for one reason: when this test wedges — and it has,
    // for over ten minutes at load 0.55, which is 0082's last open question — the pool writes the scripts
    // it is still holding to standard error. Without that, a hang here reports the name of this test and
    // nothing about which of 614 scripts caused it, and the only way to find out is to instrument the
    // harness by hand, which is what I did the first time and then deleted.
    const differences: string[] = [];
    await pool(CASES, 4, async (script) => {
      const [want, got] = await Promise.all([bash(script), wacsh(script)]);
      if (want.stdout !== got.stdout || want.code !== got.code) {
        differences.push(
          `script: ${JSON.stringify(script)}\n` +
          `  bash: ${JSON.stringify(want.stdout)} exit ${want.code}\n` +
          `  ours: ${JSON.stringify(got.stdout)} exit ${got.code}` +
          (got.stderr.trim() === "" ? "" : `\n  stderr: ${got.stderr.trim().split("\n")[0]}`),
        );
      }
    }, {
      what: "script",
      // The script itself is the label, shortened: a case is identified by what it runs, and the longest
      // here would wrap several times in a terminal.
      label: (script) => (script.length > 110 ? `${script.slice(0, 110)}…` : script),
    });
    if (differences.length > 0) {
      throw new Error(`${differences.length} of ${CASES.length} scripts differ from bash:\n\n` +
                      differences.join("\n\n"));
    }
  },
});

/**
 * Standard error arrives when it happened, not at the end of the run.
 *
 * Its own test rather than a case above, because the two shells word their diagnostics differently —
 * bash says `bash: line 1: nope: command not found` — so what is comparable is *where* the line
 * lands, not what it says. That is the whole of what issue 0014 was about: the shell used to collect
 * standard error in a buffer and flush it through `Core.warn` at the end, because the capability
 * world had no byte-level error stream, so `echo one; nope; echo two 2>&1` put the complaint after
 * both lines of output no matter when it happened.
 */
Deno.test({
  name: "standard error interleaves with standard output, as bash does",
  ignore: !haveBash,
  fn: async () => {
    const script = "echo one; nope; echo two";
    // Both streams into one file, which is the only way to observe their order. The redirection is
    // done by bash rather than by `Deno.Command`, which will not take a file handle for either.
    const both = async (cmd: string) => {
      const out = await Deno.makeTempFile({ prefix: "sh-order-" });
      const r = await new Deno.Command("bash", {
        args: ["-c", '"$0" -c "$1" >"$2" 2>&1', cmd, script, out],
        env: { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
        clearEnv: true,
      }).output();
      const text = await Deno.readTextFile(out);
      await Deno.remove(out);
      return { lines: text.trimEnd().split("\n"), code: r.code };
    };

    const theirs = await both("bash");
    const ours = await both(wacshBinary);
    const at = (lines: string[]) => lines.findIndex((l) => l.includes("not found"));
    assertEquals(ours.lines.length, 3, ours.lines.join(" | "));
    assertEquals(at(ours.lines), at(theirs.lines), `ours: ${ours.lines.join(" | ")}`);
    assertEquals(at(ours.lines), 1, "the complaint is between the two outputs");
    assertEquals(ours.lines[0], "one");
    assertEquals(ours.lines[2], "two");

    // And a diagnostic naming a file whose bytes are not valid UTF-8 survives, which the old flush
    // through a string could not do: `string.fromBytes` of an invalid sequence is not the bytes back.
    const odd = await new Deno.Command(wacshBinary, {
      args: ["-c", "cat $(printf '\\xff\\xfe')"],
      env: { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
      clearEnv: true,
    }).output();
    const raw = odd.stderr;
    assertEquals(raw.includes(0xff) && raw.includes(0xfe), true,
      `the bytes reached standard error unchanged: ${Array.from(raw).join(",")}`);
  },
});

/**
 * The shell's *own* standard input, which nothing else here exercises.
 *
 * Every case above is a script with no input piped in, which is why issue 0032 survived so long:
 * `printf x | sh -c 'cat'` printed nothing, because `stdinBytes` was only ever filled by a
 * redirection, a here-document or a pipeline. These pass the same bytes to both shells and compare
 * what comes out, so the cursor (`read` then `cat`), the empty case, and a command that consumes
 * everything are all pinned against bash rather than against my idea of bash.
 *
 * `cat; cat` is **not** here, and where it lives is the point. This binary is `packages/sh` alone, whose
 * `cat` is one of the small wac implementations in `program.wac` — a function call inside the shell,
 * handed a byte array. Nothing can tell how much of it that call read, so the shell cannot mark the
 * input consumed and the second `cat` sees it again. Where the commands are *real programs* — the shell
 * in `packages/box`, whose applets are spawned — the child is handed the shell's own descriptor and the
 * second finds what the first left, exactly as in bash. That case is pinned in
 * `packages/box/test/shell.test.ts`, and issue 0042 is where the reasoning is.
 *
 * `echo hi; cat` and `seq 1 2; cat` are the other side of it and belong here: a command that ignores its
 * input must leave it for the next one, in-process or not.
 */
const STDIN_CASES: [string, string][] = [
  ["cat", "a b c\nd\n"],
  ["read x; echo \"[$x]\"; cat", "a b c\nd\n"],
  ["echo hi; cat", "kept\n"],
  ["seq 1 2; cat", "kept\n"],
  ["read x; read y; echo \"[$x][$y]\"", "one\ntwo\nthree\n"],
  ["cat", ""],
  ["read x; echo \"[$x]\"", ""],
  ["while read line; do echo \"got $line\"; done", "a\nb\nc\n"],
  ["echo before; cat; echo after", "middle\n"],
];

Deno.test({
  name: "the shell reads its own standard input, as bash does",
  ignore: !haveBash,
  fn: async () => {
    for (const [script, input] of STDIN_CASES) {
      const fed = async (cmd: string, args: string[]) => {
        const p = new Deno.Command(cmd, {
          args,
          stdin: "piped",
          stdout: "piped",
          stderr: "null",
          env: { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
          clearEnv: true,
        }).spawn();
        const w = p.stdin.getWriter();
        await w.write(new TextEncoder().encode(input));
        await w.close();
        const out = await p.output();
        return { out: new TextDecoder().decode(out.stdout), code: out.code };
      };
      const theirs = await fed("bash", ["-c", script]);
      const ours = await fed(wacshBinary, ["-c", script]);
      assertEquals(
        ours.out,
        theirs.out,
        `${JSON.stringify(script)} over ${JSON.stringify(input)}`,
      );
      assertEquals(ours.code, theirs.code, `${JSON.stringify(script)}: exit status`);
    }

    // A script *read from* standard input consumes it, so a command inside it has nothing left —
    // `echo cat | sh` runs `cat` with no input rather than feeding it the rest of the script.
    const script = "cat\n";
    const asScript = async (cmd: string, args: string[]) => {
      const p = new Deno.Command(cmd, {
        args,
        stdin: "piped",
        stdout: "piped",
        stderr: "null",
        env: { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
        clearEnv: true,
      }).spawn();
      const w = p.stdin.getWriter();
      await w.write(new TextEncoder().encode(script));
      await w.close();
      return new TextDecoder().decode((await p.output()).stdout);
    };
    assertEquals(await asScript(wacshBinary, []), await asScript("bash", []), "script from stdin");
  },
});

/**
 * `HOME` and `OLDPWD`, which every case above runs without.
 *
 * The harness clears the environment and sets `LC_ALL` and `PATH`, deliberately: a script whose answer
 * depends on the machine's `$USER` is not a comparison. But `cd` and `cd -` read `HOME` and `OLDPWD`,
 * and with those cleared *bash* refuses too — so the corpus agreed with bash about the failure and
 * never asked about the success. `cd` alone went nowhere and said "HOME not set" while `echo $HOME` in
 * the same shell printed it, because expansion fell back to the environment and `cd` looked only at
 * variables this shell had assigned.
 *
 * Two named variables, both set to a temporary directory, so the answer is still the shell's and not
 * the machine's. `~` is here for the same reason and could not have been compared above either: with
 * `HOME` unset bash reads the password file instead, so `echo ~` would be the container's own answer.
 */
Deno.test({
  name: "HOME and OLDPWD reach `cd`, `cd -` and `~`, as they do in bash",
  ignore: !haveBash,
  fn: async () => {
    const home = await Deno.makeTempDir({ prefix: "sh-home-" });
    const old = await Deno.makeTempDir({ prefix: "sh-old-" });
    const from = await Deno.makeTempDir({ prefix: "sh-from-" });
    try {
      const cases = [
        "cd; pwd",                     // HOME from the environment
        "cd -",                        // OLDPWD from the environment, and `cd -` prints where it went
        'cd ""; pwd',                  // present but empty: a no-op, not "go home"
        "cd; cd -; pwd",               // and OLDPWD as this shell set it, not as it inherited it
        "HOME=; cd; pwd",              // assigned empty in this shell, which is not the same as unset
        "cd nowhere; pwd",             // still where it was, and status 1
        "cd; echo st=$?",
        // Tilde expansion, which is the same `HOME` and could not be compared with it cleared either:
        // bash falls back to the password file, so `echo ~` there prints the real home directory and
        // nothing in this container's environment makes the two shells agree.
        "echo ~",
        "echo ~/x",
        'echo "~"',                    // quoted: a tilde is a tilde
        "echo \\~",
        "echo a~",                     // not at the front of the word
        "echo ~a",                     // a user name, which neither shell can resolve here
        "echo ~/x ~",
        "echo ~:~",                    // in a *word* only the leading one expands
        "echo ~:x",                    // …and a colon ends a tilde-prefix even so
        "echo ~=x",                    // while other punctuation does not: a word, not a home
        "echo ~/a:~/b",                // still one, in a word
        'echo "a~"~',                  // …and the front of the word is not the front of a part
        "x=~/a; echo $x",
        "y=/u:~/b; echo $y",           // in an assignment, one after every colon
        "v=~:~; echo $v",              // …so both of these expand, unlike in the word above
        "z=~; echo $z/y",              // expanded once, at assignment time
        "cd ~; pwd",
        "echo hi > ~/f; cat ~/f",      // a redirection target, which is why `joinWord` does it too
      ];
      for (const script of cases) {
        const run = (cmd: string, args: string[]) =>
          new Deno.Command(cmd, {
            args,
            cwd: from,
            stdin: "null",
            stdout: "piped",
            stderr: "null",
            env: { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin", HOME: home, OLDPWD: old },
            clearEnv: true,
          }).outputSync();
        const theirs = run("bash", ["-c", script]);
        const ours = run(wacshBinary, ["-c", script]);
        const text = (r: Deno.CommandOutput) => new TextDecoder().decode(r.stdout);
        assertEquals(text(ours), text(theirs), `${JSON.stringify(script)}: output`);
        assertEquals(ours.code, theirs.code, `${JSON.stringify(script)}: exit status`);
      }
    } finally {
      for (const d of [home, old, from]) await Deno.remove(d, { recursive: true });
    }
  },
});

/**
 * The builtins' *diagnostics*, against GNU's own.
 *
 * Every case above compares standard output, which is the right default — a shell's job is what it
 * prints — and it means the wording of a failure was never checked against anything. `mkdir` and `rm`
 * are the two builtins here that GNU also ships as programs, so their lines are comparable, and they
 * were not comparable at all: they carried the host's errno and an absolute path GNU does not print
 * ("File exists (os error 17): mkdir '/tmp/…'"), which also differed by runtime — Node says
 * "EEXIST: file already exists" for the same fault.
 *
 * `LC_ALL=C` matters here and is why the harness above sets it: GNU quotes the path with typographic
 * marks in a UTF-8 locale and with apostrophes in C.
 */
Deno.test({
  name: "a file that cannot be read is reported in GNU's own words",
  ignore: !haveBash,
  fn: async () => {
    // The *reason* used to be the host's: "No such file or directory (os error 2): readfile
    // '/tmp/x/missing'" under Deno, and "ENOENT: no such file or directory, open '…'" under Node — one
    // fact, three spellings, none of them GNU's four words. `FileResult` carries a fault category now
    // (wac-mono 0062), so each program translates the category rather than printing the sentence.
    //
    // The whole line is compared, not just the reason: each of these tools words the *prefix*
    // differently too — `head` says "cannot open 'x' for reading", `sort` says "cannot read: x", `rev`
    // says "cannot open x" — and those were already matched, which is what makes the whole line
    // comparable now that the reason is.
    const dir = await Deno.makeTempDir({ prefix: "sh-unread-" });
    try {
      const cases = [
        // Usage errors, which GNU words to the byte and follows with a "Try 'x --help'" line. They are
        // here rather than in a test of their own because the property is the same one: where the
        // message is derivable it is compared, and where it is *ours* — a gap this shell has and GNU
        // does not — it is not comparable and is not compared.
        "seq",
        "seq abc",
        "seq 1 2 3 4",
        "seq 1 0 3",
        "seq -q 1",
        "seq --nope 1",
        "echo x | cat -Q",
        "cat missing",
        "wc -l missing",
        "head -1 missing",
        "tail -1 missing",
        "sort missing",
        "uniq missing",
        "rev missing",
        "nl missing",
        "grep x missing",
        // `ls`'s own wording, which was invented rather than GNU's until 0067's work went past it: it said
        // `ls: x: no such file or directory` where GNU says `ls: cannot access 'x': No such file or
        // directory`. Nothing compared it, because every `ls` case in the corpus lists something that
        // exists.
        "ls nosuchthing",
      ];
      for (const script of cases) {
        const run = (cmd: string, args: string[]) =>
          new Deno.Command(cmd, {
            args,
            cwd: dir,
            stdin: "null",
            stdout: "null",
            stderr: "piped",
            env: { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
            clearEnv: true,
          }).outputSync();
        const theirs = new TextDecoder().decode(run("bash", ["-c", script]).stderr).trim();
        const ours = new TextDecoder().decode(run(wacshBinary, ["-c", script]).stderr).trim();
        assertEquals(ours, theirs, script);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "mkdir and rm say what GNU says when they fail",
  ignore: !haveBash,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "sh-diag-" });
    try {
      await Deno.mkdir(`${dir}/full/inner`, { recursive: true });
      await Deno.mkdir(`${dir}/taken`);

      // Builtins only. This binary is `packages/sh` alone, so `rmdir` here is "command not found" —
      // it is `packages/box`'s applet, and its "Directory not empty" is compared against GNU in
      // `box/test/shell.test.ts` where that applet exists.
      const cases = [
        "mkdir taken",      // exists
        "rm nosuchthing",   // absent
        "rm full",          // a directory, without -r
      ];
      for (const script of cases) {
        const run = (cmd: string, args: string[]) =>
          new Deno.Command(cmd, {
            args,
            cwd: dir,
            stdin: "null",
            stdout: "null",
            stderr: "piped",
            env: { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
            clearEnv: true,
          }).outputSync();
        const theirs = new TextDecoder().decode(run("bash", ["-c", script]).stderr).trim();
        const ours = new TextDecoder().decode(run(wacshBinary, ["-c", script]).stderr).trim();
        // The reason, which is the part a person reads and the part that was wrong. Compared rather than
        // the whole line because a prefix can legitimately differ in shape; the reason cannot.
        const reason = (line: string) => line.slice(line.lastIndexOf(": ") + 2);
        assertEquals(reason(ours), reason(theirs), `${script}\n  ours:  ${ours}\n  theirs: ${theirs}`);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
