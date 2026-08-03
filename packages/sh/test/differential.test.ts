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
  `seq 1 5 | head -n 2`,
  `seq 1 5 | tail -n 2`,
  `seq 1 10 | grep 1`,
  `seq 1 3 | nl`,
  `echo one two three | tr ' ' ','`,
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
 * Absolute paths, because this shell has no working directory of its own — there is no `cd` and
 * no capability to ask where it is — so a relative pattern would mean different things to the two
 * shells and the comparison would prove nothing.
 */
const globDir = await Deno.makeTempDir();
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

async function bash(script: string) {
  const r = await new Deno.Command("bash", {
    args: ["-c", script],
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
const wacshBinary = await (async () => {
  const out = await Deno.makeTempFile({ prefix: "wacsh-" });
  const r = await new Deno.Command("deno", {
    args: [
      "run", "-A", "packages/platform/build.ts", "packages/sh/src/sh.wac",
      "--allow-read", "--allow-write", "--allow-env", "-o", out,
    ],
  }).output();
  if (!r.success) throw new Error(`building sh failed: ${new TextDecoder().decode(r.stderr)}`);
  return out;
})();

async function wacsh(script: string) {
  const r = await new Deno.Command(wacshBinary, {
    args: ["-c", script],
    env: { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin", HOME: Deno.env.get("HOME") ?? "" },
    clearEnv: false,
  }).output();
  return {
    stdout: new TextDecoder().decode(r.stdout),
    code: r.code,
    stderr: new TextDecoder().decode(r.stderr),
  };
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
    // Eight at a time. Each script is two subprocesses and one of them compiles the shell, so
    // serially this is twenty-odd seconds of a suite that runs in thirty.
    const differences: string[] = [];
    const queue = [...CASES];
    async function worker() {
      while (queue.length > 0) {
        const script = queue.shift()!;
        const [want, got] = await Promise.all([bash(script), wacsh(script)]);
        if (want.stdout !== got.stdout || want.code !== got.code) {
          differences.push(
            `script: ${JSON.stringify(script)}\n` +
            `  bash: ${JSON.stringify(want.stdout)} exit ${want.code}\n` +
            `  ours: ${JSON.stringify(got.stdout)} exit ${got.code}` +
            (got.stderr.trim() === "" ? "" : `\n  stderr: ${got.stderr.trim().split("\n")[0]}`),
          );
        }
      }
    }
    await Promise.all(Array.from({ length: 4 }, () => worker()));
    if (differences.length > 0) {
      throw new Error(`${differences.length} of ${CASES.length} scripts differ from bash:\n\n` +
                      differences.join("\n\n"));
    }
  },
});
