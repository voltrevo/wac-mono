# 0087 — the native runtime: a second host, with no JavaScript and no WASI in it

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-c
- **Date:** 2026-08-06
- **Kind:** missing feature
- **Symptom:** not implemented

Step 2a of [design/0001](../../design/0001-a-self-contained-system.md), where D9, D10 and D11 hold the
reasoning. This is the actionable slice.

## What

A runtime binary that runs wac programs: the peer of `packages/platform/host/{browser,node,deno}.ts`,
in the role Deno plays but Wasm-native, in **Rust on wasmtime**, with no JavaScript in it and no WASI
reaching the guest.

It is the only host that tests the portability claim at all — the other three are JavaScript and share
the transport, the worker model and the event loop.

## What it has to do

Six things, and the list is shorter than the JavaScript host's:

1. load a wac-compiled module — **no bundle**, since there is no JavaScript to bundle;
2. supply the capability funcrefs as host functions;
3. a **ticket table**: request to id, completed from the runtime's own threads;
4. `waitAny(ids, timeoutMs)` — park the calling wasm thread until one is ready or the deadline passes;
5. **`spawn`** — instantiate into a new store on its own thread, with a world derived from the parent's
   grants, routing bytes between parent and child queues;
6. the operating system underneath, through `std::fs`, `std::net` and threads — never exposed to the
   guest, because it is the *implementation* of a capability and not a capability.

The `SharedArrayBuffer`, `Atomics.wait`, the sequence counters, the ring of slots and the responder are
expected to have **no counterpart here**. They exist to park a worker while an asynchronous host runs;
native code blocks the calling thread directly. If this finds itself reimplementing the ring of slots,
stop and say so — that would mean the interface and the transport are less separable than D9 assumes,
which is worth more than the runtime.

## Done when

With no JavaScript in the artifact and no WASI import in the module:

- a program issues **two** capability requests that complete **out of order**, `waitAny`s over both,
  and observes them settle independently — the later request first, each resolving its own value;
- a `waitAny` with neither ready returns on its **timeout**;
- the program **spawns a child** and `waitAny`s over one of its own tickets *and* the child's exit at
  the same time.

The third clause is the point. A runtime that cannot make a second instance is not a host for this
system, and a readiness table that only handles one kind of event fails there and nowhere else.

**A host that resolved every ticket immediately would pass the types and fail this**, which is why
out-of-order completion is in the criteria rather than a single request. Such a host would make every
program that overlaps requests silently sequential — `packages/tor`'s SOCKS proxy holds one outstanding
read per socket plus an accept and hands the list to `waitAny`, and it would still *work*, one
connection at a time, which is D6's shape.

## Why spawn is in scope here and the process table is not

`spawn` is the primitive; the table is step 3. But the primitive cannot be deferred: a wasm module
cannot instantiate another wasm module, so if the runtime cannot do it, nothing later can add it —
and the design would have been built on a host that could not carry it.

There is a second reason to want it early. `children.ts` is careful to say that today "the isolation is
the language's, not the runtime's": a wac child cannot escape its capabilities because wac has no
ambient anything, but arbitrary JavaScript in a spawned worker can, since Deno workers inherit the
process's permissions. Under this runtime a child instance gets **exactly the imports the host gives
it**. `spawn` becomes a confinement primitive rather than only a composition one, on this host first.

## The toolchain is in place (2026-08-06)

Settled, so nobody repeats it:

- **`rustc` and `cargo` 1.97.1, via rustup**, on the PATH in every shell. `~/.zshenv` and `~/.profile`
  source `~/.cargo/env`; the rustup shims are also symlinked into `/usr/local/bin`, because Claude
  Code's tool shells source a snapshot that pins `PATH` *after* `.zshenv` is read and would otherwise
  never see them.
- **Ubuntu's `rustc` 1.75 is not enough and has been removed.** It installs from `ports.ubuntu.com`
  with no allowlist change, and then cannot build wasmtime: current wasmtime (47.x) requires
  `edition2024`, which needs Rust 1.85+. `cargo fetch` fails with "the package requires the Cargo
  feature called `edition2024`". Two toolchains on the PATH is a trap, so there is one.
- **Proxy allowlist**, all five added by the operator and all five used: `index.crates.io` and
  `static.crates.io` for the registry and the downloads, `crates.io` for `cargo add`, and
  `sh.rustup.rs` with `static.rust-lang.org` for the toolchain itself.
- **Measured**, on a trivial wasmtime host: release build 1m28s at 401% CPU, a 17.2 MB unstripped
  binary with default features, and ~850 MB of toolchain on the shared home (`~/.rustup` 520 MB,
  `~/.cargo` 333 MB). A real runtime should trim wasmtime's features hard; the default pulls in the
  pooling allocator, profiling, `wat` and `wit-parser`, none of which this needs.
- **The two mechanisms D10 rests on are proven** by a probe: `Func::wrap` supplying a host function to
  the guest, and a second `Instance` created from the host with its own `Store` and only the imports
  that call handed it. That second one is `spawn`, and it is why `spawn` is a confinement primitive on
  this host and not on the others.

## Still an operator decision

**This repo has no compiled language today** — 371 `.wac`, 305 `.ts`, with Python and shell only as
tooling. Where the runtime lives is undecided: its own bare repo, or `packages/platform/host/native/`.
See 0001's open questions. Worth settling before code lands rather than after.

Only whoever *builds* the runtime needs the toolchain; everyone else needs a binary.

## Not in scope

No shell, no services, no image format, no process table. A `.wasm` and a manifest of grants is the
whole artifact; `buildApp` gains a target that emits it.

## D12: build the ticket table with a scheduler seam in it (operator, 2026-08-06)

design/0001 gained **D12 — a fully deterministic execution mode is a goal of the native runtime, and only
partly reachable before it.** It bears directly on items 3 and 4 above.

In the JavaScript hosts a test scheduler can own *which answer is delivered next* but not *which real call
has completed*, because that is the kernel's. A worker parked on two OS-backed tickets — one of which
cannot complete until something else is unblocked — is indistinguishable from one that is merely slow. So
the JavaScript mode can improve reproducibility and cannot guarantee it.

Wacland is where that boundary moves, because the runtime owns the ticket table, the threads and the
clock. Two consequences for the design of items 3 and 4:

- **the ticket table should be able to answer "who is runnable?" without asking the operating system.**
  Completion is recorded by the runtime's own threads, so it already knows; the seam is making that
  queryable and making delivery order a policy rather than an accident.
- **`waitAny` should take its choice from that policy** when more than one ticket is ready. The protocol
  permits returning either, and in a deterministic mode the choice has to be the scheduler's rather than
  whichever thread happened to finish first.

Neither is extra machinery — it is where the machinery is put. Adding a seam afterwards means retrofitting
it through every completion path, which is the shape of change this project keeps paying for elsewhere.
