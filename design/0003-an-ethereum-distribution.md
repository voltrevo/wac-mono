# 0003 — an Ethereum distribution: what arriving looks like

- **Status:** destination
- **Opened:** 2026-08-06
- **Written by:** agent-c, from a decision with the operator
- **Source:** [voltrevo/wac-mono#39](https://github.com/voltrevo/wac-mono/issues/39), read inward

## Read this differently from 0001 and 0002

Those are directions with an order of work. **This one has no order of work, deliberately.** It is the
shape of a system several independent lines of work converge on, written down so that each of them can
be judged against where it is going — not a sequence anybody should follow top to bottom.

`design/README.md` asks for "the order of work, with what done looks like for each step". A destination
answers a different question, so the state of play below tracks *contributing pieces* rather than steps,
and the pieces are ordered by dependency rather than by intent. If this ever acquires a sequence it
should become an ordinary direction and say so.

## What we are aiming at

One coherent system for interacting with Ethereum — not a generic installation with Ethereum tools
added afterwards. A person can:

- see which network backend is in use, and replace it;
- connect or create an account without any application seeing a private key;
- resolve ENS names through the same chain access everything else uses;
- read contract state without trusting whoever served the answer;
- subscribe to contract events and have them arrive as ordinary system notifications;
- inspect a signing request — which application, what action, what destination, what a simulation says —
  and approve or reject it;
- point the update channel at a contract they chose, and migrate to a fork of it.

## The two decisions already taken

**E1 — this is not gated behind Wacland** (operator, 2026-08-06). #39 describes the distribution as a
Wacland image, and that is the right end state. It is not the build order: the verification core here is
the most finished thing in the repo, and Wacland is at step 1 of 8. The reference application is built
against the platform that exists today, and moves onto Wacland when Wacland exists. What that buys is
the interfaces — chain access, signing mediation, notifications — pinned by something that runs.

**E2 — the core exposes nothing Ethereum-shaped.** Wacland stays independent of Ethereum: generic
facilities only, every authority and dependency explicit and replaceable. No Foundation-operated
service, no canonical provider, no permission from a maintainer, and no contract holding automatic
system authority. A person can pin a version, choose their own recognised publishers, and move to a
forked channel. This is a constraint on the distribution, not a feature of it.

## State of play

Ordered by dependency, not by intent.

| piece | state |
| --- | --- |
| consensus verification — `packages/lightclient` | **done** — Altair sync, all four of Ethereum's `light_client/sync` cases, 19 steps, 16 real sync-committee signatures |
| SSZ and Merkle proofs — `packages/ssz` | **done** — 2,233 Ethereum vectors, including all 1,131 *invalid* `ssz_generic` |
| BLS12-381 verification — `packages/bls` | **done** — all 29 Ethereum verify fixtures, ~8ms a signature |
| keccak256 | **done** — `crypto.keccak256`, the sponge's fourth domain byte; three published vectors at three lengths, and asserted to disagree with SHA3-256 and truncated SHAKE256 |
| RLP — `packages/rlp` | **done** — Ethereum's own `RLPTests`, 28 valid driven in both directions against the published bytes and 26 invalid all refused; the one rule the corpus does not cover is named in `test/vendor/README.md` |
| ABI encoding and decoding | not started |
| Merkle-Patricia state proofs | not started — **the gap between a verified header and reading a contract**, and the piece E2's "without trusting a provider" actually rests on |
| ENS resolution | not started — downstream of keccak256, ABI and state proofs |
| secp256k1 signing | not started — see the section below, which is the reason it is last |
| content-addressed retrieval (IPFS or otherwise) | not started — needs a decision about what is being promised |
| notifications, update channels, atomic activation with rollback | not started — these are Wacland's, see [0001](0001-a-self-contained-system.md) |
| hosting the whole thing as a Wacland image | [0001](0001-a-self-contained-system.md), and **not a prerequisite** — E1 |

## Signing is a different risk class, and gets a different gate

The centrepiece of #39 is narrowly scoped signing on behalf of a user. That means secp256k1 ECDSA with
secret material, and `packages/crypto`'s own README says of everything shipped so far:

> **Not for production.** Two routines here are known to leak, and the rest are uniform only at the
> level this can measure … do not use this where an attacker can observe timing.

`packages/bls` avoided the whole question on purpose — verification only, no secret material anywhere,
"so nothing here needs to be constant-time, and the whole class of timing bug that makes elliptic-curve
code hard to write does not arise". An accounts service cannot have that scope decision.

**This is a reason to sequence it last, not a reason it cannot be done.** The repo is better equipped
than most: `harness/ctTrace.ts` compiles in the compiler's trace mode and compares the ordered sequence
of branches *and* array indices between runs differing only in the secret — the second half matters,
because a secret-dependent index has no branch and a branch-counting tool calls it uniform. A failure is
definite, at a named source line. `packages/bls`'s README already says where this work goes: "a different
file with `ctTrace` over it, not bolted onto these functions."

So the decision to take when it starts, recorded here so it is not rediscovered:

- every secret-consuming routine under `assertNoSecretDependence` from the **first** commit, not
  retrofitted, and with structured keys — all zero, all ones, a single bit set — rather than random ones;
- constant-time inversion, or blinding, chosen **by construction**, because `ctTrace` is dynamic and
  wasm-level: a pass is necessary and not sufficient, and it cannot see that `i64.div_s` latency depends
  on its operands;
- and the distribution says plainly what has and has not been reviewed, for as long as that is true.

secp256k1 is also a third field implementation rather than a reuse: `crypto/src/fieldp.wac` does P-256
and P-384 together because both are Solinas primes, `packages/bls` is Montgomery because BLS12-381's
prime has no such structure, and secp256k1 is pseudo-Mersenne. `packages/bls`'s README has the reasoning
for why that sharing does not happen.

## Explicitly not this

From #39, and worth keeping because each one is a thing a reader will otherwise assume: Ethereum is not
mandatory for Wacland; no contract gets automatic system authority; binaries do not go onchain; private
keys are never exposed to an application; and no particular network, committee or governance model is
required.

## The actionable slices

Issues reference this document rather than restating it. Unblocked today, in dependency order:

- [0083](../issues/open/0083-keccak256-for-ethereum-not-just-sha3.md) — keccak256
- [0084](../issues/open/0084-rlp-encoding-and-decoding.md) — RLP
- [0085](../issues/open/0085-abi-encoding-and-decoding.md) — ABI
- [0086](../issues/open/0086-merkle-patricia-proofs-so-a-contract-read-is-verified.md) — state proofs

Not yet issues, and why: **ENS** needs the three above; **signing** needs its gate designed first;
**content-addressed retrieval** needs a decision about what is being promised; the **reference
application** needs the interfaces the above produce.
