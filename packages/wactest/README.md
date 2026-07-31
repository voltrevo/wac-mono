# wactest

Assertions for tests written in wac.

```wac
import { T } from "../../../wactest/src/assert.wac";
import { crc32 } from "../../src/crc32.wac";

export string test_crc32_of_hello_world() {
  T t = T.create();
  u8[] data = u8[](104, 101, 108, 108, 111);
  t.eqI32(crc32(data), 907060870, "crc32(\"hello\")");
  return t.report();
}
```

Run it by registering the file from a `.test.ts`:

```ts
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/gzip/test/wac/huffman_test.wac", "huffman");
```

## The shape, and why

**A test is an exported function returning `string`** — empty means pass. That
makes discovery free: `wacCompile` returns export *names*, so a runner can call
every no-argument `test*` export returning `string`. No annotations, no
registration, no language feature.

**Assertions record rather than trap.** `trap` carries no message, so a trapping
assertion would tell you only that something failed. Recording also means one run
reports every failure instead of stopping at the first.

**Failures accumulate in a `T` the test owns.** wac has no top-level mutable
state, so there is nowhere global to put them; the test creates a `T` and returns
`t.report()`.

## Assertions

| | |
|---|---|
| `eqI32(got, want, what)` | equality, message names both values |
| `neI32(got, unwanted, what)` | inequality |
| `isTrue(cond, what)` / `isFalse` | boolean |
| `eqStr(got, want, what)` | string equality |
| `eqI32Array(got, want, what)` | length then first differing element |
| `eqBytes(got, want, what)` | same for `u8[]`, compared zero-extended |
| `failNow(what)` | unconditional — for a branch that should be unreachable |

`itoa` is exported separately for building messages of your own. It exists
because `string + i32` is deliberately a compile error in wac and there is no
built-in number-to-string; it works by indexing `"0123456789"`, since indexing a
string yields a one-character string.

## What this cannot do

Anything needing an external oracle or the outside world. Differential testing
against another implementation, interop with a real tool, reading files, spawning
processes — none of that can happen inside wasm. Those tests belong in a
host-side `.test.ts`, and for `gzip` that is where most of the value is.

So this is for unit tests of wac code. It complements the host-side suite rather
than replacing it.

## Float assertions

`eqF64` compares through `f64.toBits`, not `==`, so NaN equals NaN and `-0.0` is
distinct from `0.0` — the two cases `==` gets wrong for a test's purposes.
`nearF64(got, want, tol)` is the tolerance form, and rejects NaN rather than letting
a false comparison pass it.

Both name the offending value in the failure message, which needs float-to-string
and so depends on [`fmt`](../fmt/). That dependency is why they did not exist
before: an assertion that cannot say what it got is close to useless.

`itoa` used to live here for the same reason and has moved to `fmt`, next to
`ftoa` — same job, other numeric type, and a test library is not the natural home
for number formatting.
