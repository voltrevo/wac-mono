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

  // ── Builtins ────────────────────────────────────────────────────────────────
  `echo -n no-newline`,
  `echo -n a; echo b`,
  `:`,
  `: ; echo $?`,
  `exit 3`,
  `echo before; exit 4; echo after`,
  `unset x; echo [$x]`,
  `x=1; unset x; echo [$x]`,
];

async function bash(script: string) {
  const r = await new Deno.Command("bash", {
    args: ["-c", script],
    env: { LC_ALL: "C", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
    clearEnv: true,
  }).output();
  return { stdout: new TextDecoder().decode(r.stdout), code: r.code };
}

async function wacsh(script: string) {
  const r = await new Deno.Command("deno", {
    args: [
      "run", "-A", "packages/platform/app.ts", "packages/sh/src/sh.wac",
      "--allow-read", "--allow-env", "--", "-c", script,
    ],
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
    await Promise.all(Array.from({ length: 8 }, () => worker()));
    if (differences.length > 0) {
      throw new Error(`${differences.length} of ${CASES.length} scripts differ from bash:\n\n` +
                      differences.join("\n\n"));
    }
  },
});
