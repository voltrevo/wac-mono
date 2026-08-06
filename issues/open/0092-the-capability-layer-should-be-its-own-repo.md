# 0092 — the capability layer should be its own repo (`wac-platform`)

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-c
- **Date:** 2026-08-06
- **Kind:** missing feature
- **Symptom:** not implemented

Move `packages/platform` out of wac-mono into a repo of its own. Decided with the operator on
2026-08-06; this is the record, because nothing else holds it.

## Why it does not belong here

wac-mono is a repo of **wac libraries**: 32 packages, 64k lines of wac, and the rule that the
interesting code is in `src/*.wac` with TypeScript only as harness. `platform` inverts that ratio —
**3,289 lines of wac and 13,270 of TypeScript** as of 2026-08-06, most of it in `host/`, which is 17
files of worker lifecycle, a `SharedArrayBuffer` ring, sequence counters, a responder and three
runtime adaptors. The ratio is the point rather than the figures, and it has not moved.

That is not a library that happens to have a host. It is a platform: it juggles workers and
messaging and binds external capabilities, and everything else here is built *on* it — `box`, `fs`,
`sh`, `ssh` and `tor` all import it, and nothing it depends on runs the other way.

The second reason is [0087](0087-wacland-under-wasmtime-a-second-host-with-no-javascript.md). The
native runtime is a fourth host in **Rust**, and 0087 already records the operator's discomfort:
"'no dependencies, everything in `src/`' is a stated property of this repo that '…and some Rust'
muddies." A repo whose subject is the capability layer has an obvious place for a second
implementation of it. This one does not, and 0087's "still an operator decision" is that question
asked from the other end.

## What moves

`packages/platform/` entire — `src/` (the capability structs, `stream.wac`), `host/`, `example/`,
`test/`, `bench/`, `build.ts`, `app.ts`, `README.md`.

The harness is the part to think about rather than copy. Eight files mention platform, and they
split cleanly in principle: `appRun.ts` and `programs.ts` are about running platform applications
and go with it; `buildCache.ts`, `wacFiles.ts` and `wacBind.ts` are about compiling wac at all and
stay. `port.ts`, `spawnRetry.ts` and `wacProfile.ts` need looking at rather than assuming.

## What is already unblocked

`Read` — which was the hard one, and is done as of today. A capability hands `cli.readChunk` to a
streaming transform in another package, and wac has no closures, so no adapter can sit between them:
a `Read` declared in wac-platform and a `Read` declared in wac-mono could never have met. It is now
in `core`, the module the compiler ships, so both repos name one type.

## What actually blocks it

**Step 3 of [wac's `design/0001`](../../../wac/design/0001-import-resolution-core-and-what-packages-inherit.md)
— a directory provider.** Today every import here is a relative path, so the five dependent packages
would have to reach platform as `../../../wac-platform/src/platform.wac`: a path out of one checkout
and into a sibling, which is right only for whoever cloned things the way the author did.

The mechanism exists and is one provider short. `core` landed with `importKey` in `wacResolve` as the
single place a specifier becomes a key, and a prefix pointing at a directory goes exactly there. This
is the reason to do that step, and there is no reason to start the move before it.

## The other shared type, and why it is not the same problem

`platform/src/stream.wac` imports `Buf` from `packages/bytes`. **Copy it into wac-platform** rather
than reaching for a second entry in `core`, and the reason is the admission rule: `Read` had to be
one type because a funcref signature names it, and no signature here names `Buf`. Every crossing is
`u8[]`.

The caveat, so nobody hits it as a surprise: `Sink.held` and `Lines.pending` are `Buf`-typed
**fields** of exported structs, so a caller that reads one gets *platform's* `Buf`. Methods still
work — they come from the type — but wac-mono's `Buf` cannot be passed where platform's is expected.
Nothing does that today, which was checked rather than assumed. If something ever needs to, the fix
is a `u8[]` accessor and not a shared declaration.

## Done when

- `wac-platform` has its own bare repo, and `packages/platform` is gone from here;
- `box`, `fs`, `sh`, `ssh` and `tor` import it by prefix — no `../../../` into a sibling checkout;
- both suites are green, and `deno task app` still builds and runs an application from wac-mono;
- 0087's runtime has a home that does not make this repo's "everything in `src/`" untrue.

## Not in scope

The native runtime itself (0087), Wacland (`design/0001`), and any change to what the capability
world *is*. This is a move, and it should be legible as one: if the diff contains a design change,
it will be impossible to review either.
