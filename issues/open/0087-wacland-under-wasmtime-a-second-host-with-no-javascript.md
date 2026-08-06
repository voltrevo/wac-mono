# 0087 — Wacland under Wasmtime: a second host, with no JavaScript in it

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-c
- **Date:** 2026-08-06
- **Kind:** missing feature
- **Symptom:** not implemented

Step 2a of [design/0001](../../design/0001-a-self-contained-system.md), where D9 and the reasoning live.
This issue is the actionable slice, and it is a **spike**: its job is to answer a question, and the code
it produces is worth less than the answer.

## The question it has to answer

Can the capability interface be bound to a host with no JavaScript — and if so, does plain WASI reach,
or does it need an embedding?

`waitAny(ids, timeoutMs)` maps almost exactly onto WASI's `poll_oneoff`: a list of subscriptions, the
timeout as a clock subscription in the same list, returning which fired. That is the encouraging half.
The other half is that `poll_oneoff` subscribes to **file-descriptor readiness and clocks only**, so:

| ticket for | has a WASI subscription? |
| --- | --- |
| a socket read, a timeout | yes |
| a file read | via a descriptor, probably |
| `render`, `nextEvent`, a child's exit | **no** |

So either the host maps those onto descriptors it owns, or `wasmtime run` is not enough and the host is
an embedding — Rust or C with `Func::wrap` and its own readiness table. That is a new language in this
repo, so it is a decision for the operator rather than something to pick while coding. **Answering which
is the point of this issue.** Report it either way; a spike that concludes "an embedding is required"
has succeeded.

## Done when

With **no JavaScript anywhere in the artifact**, under `wasmtime`:

- a program issues **two** capability requests that complete out of order,
- `waitAny`s over both,
- and observes them settle independently — the later request first, and each `resolve`ing its own value;
- and a `waitAny` with neither ready returns on its **timeout**.

That is the whole of it. Not "runs a program against the VFS", which would pass without touching the
thing in question.

**A host that resolved every ticket immediately would pass the types and fail this**, which is why the
out-of-order completion is in the criteria rather than a single request. Such a host would make every
program that overlaps requests silently sequential — `packages/tor`'s SOCKS proxy holds one outstanding
read per socket plus an accept and hands the list to `waitAny`, and it would still *work*, one
connection at a time, which is D6's shape.

## What is deliberately not in it

No processes, no shell, no services, no image format. `spawn` has no answer in WASI preview 1 and the
process table is step 3; a first Wasmtime host is honestly one instance with in-process children, which
is what `pushChild`/`popChild` already does for sixty applets in a browser tab.

## Notes

`wasmtime` is not installed here — needs `sudo`, and its download host is likely not on the proxy
allowlist, so that is an ask for the operator before anyone starts.

The transport is expected to disappear rather than be ported. The `SharedArrayBuffer`, `Atomics.wait`,
the sequence counters and the responder exist to park a worker while an asynchronous host runs; a host
that is already synchronous needs none of it. If the new binding finds itself reimplementing the ring
of slots, that is worth stopping to explain — it would mean the interface and the transport are not as
separable as D9 assumes.
