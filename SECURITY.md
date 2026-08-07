# Security

## What this is

`wac-mono` is a set of packages written from scratch in [wac](https://github.com/voltrevo/wac), a
language that compiles to WebAssembly. It contains implementations of TLS 1.3, Tor, SSH, and a
collection of cryptographic primitives.

**None of it has been audited. None of it is constant-time. It is not intended for production, and
it should not be used to protect anything you would mind losing.**

That is not modesty. It is the design constraint the work is done under, and the packages say so
individually: `packages/tor/README.md` opens by saying the package should not be pointed at the real
Tor network, and enumerates the anonymity properties it does not have.

What the project *does* claim is narrower and testable: that these implementations agree with the
reference ones. Every package is checked against something written by somebody else — OpenSSL and
rustls for TLS, C tor for Tor, OpenSSH for SSH, published test vectors for the primitives — and where
an oracle does not exist, the tests say so rather than comparing the code against itself.

## What is a vulnerability here, and what is not

**Already known, and not a vulnerability:**

- **Nothing is constant-time.** No primitive in `packages/crypto` is written to resist timing
  analysis, the language offers no control over it, and a report that a comparison or a scalar
  multiplication leaks timing is describing a known property rather than finding one.
- **The anonymity gaps listed in `packages/tor/README.md`** under *What is not here* — partial
  Proposal 271, no WTF-PAD or circuit padding, stream isolation by port rather than by destination,
  no preemptive circuits. These are enumerated with the reasoning; they are open work, not defects.
- **Anything that requires pointing this at the real Tor network**, which the documentation says not
  to do.

**Worth reporting:**

- A memory-safety or correctness bug reachable from untrusted input — a malformed cell, certificate,
  descriptor, consensus or packet that causes a trap, a hang, or a wrong answer.
- An implementation that disagrees with its reference in a way that weakens it: a signature that
  verifies when it should not, a MAC that is not checked, a length that is not bounded.
- A capability escape in `packages/platform` — a program reaching a file, host or environment
  variable it was not granted.
- Anything in the build or release path that would let someone else's code end up in what we ship.

If you are unsure which of those two lists something belongs in, report it. Sorting it out is our
job, not yours.

## How to report

Use **private vulnerability reporting** on this repository — the *Security* tab, *Report a
vulnerability*. That goes to the maintainer privately and is preferred over a public issue for
anything in the second list above.

Please include what you did, what happened, and what you expected. A reproduction is welcome and not
required; a description of the reasoning is often enough for code this size.

## What to expect

This is a research project maintained in someone's spare time and largely written by AI agents. There
is **no bounty**, no service-level agreement, and responses are best-effort. You will get an
acknowledgement and an honest answer about whether it will be fixed and when.

We would rather hear about something that turns out to be known than not hear about something that is
not.

## Reporting a weakness in code that is not ours

If you find a weakness in C tor, OpenSSL, or any other project while reading this repository, please
report it to *them*, privately, rather than to us. The same rule binds the agents working on this
repository: a finding in somebody else's code goes to its maintainers before it goes into a commit
message, an issue, a design note or a blog post.
