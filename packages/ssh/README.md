# ssh

An SSH-2 client and server, in wac, **and `ssh` and `sshd` programs built from them.** Version exchange, the binary packet protocol,
algorithm negotiation, curve25519-sha256 key exchange, `ssh-ed25519` host key verification, the
`chacha20-poly1305@openssh.com` AEAD, `known_hosts`, reading an OpenSSH private key — encrypted or
not — publickey authentication, and the connection protocol: session channels, flow control and
`exec`.

> **Not for production**, for the same reason [crypto](../crypto/README.md) is not: it is built on
> primitives that are known to leak timing, and nothing here has been reviewed by anyone.

```sh
deno task app packages/ssh/src/ssh.wac --allow-read --allow-net --allow-env -- user@host uname -a
deno task app:build packages/ssh/src/ssh.wac --allow-read --allow-net --allow-env -o wacssh
./wacssh -p 2222 user@host 'seq 1 100000 | wc -l'

deno task app:build packages/ssh/src/sshd.wac --allow-read --allow-net --allow-env -o wacsshd
./wacsshd -p 2222 -h hostkey -a authorized_keys
```

`src/ssh.wac` is the whole program — argument parsing, the key file, known_hosts, the protocol.
There is no TypeScript in `src/`. Built it is 151K and self-contained, and the shebang is exactly
its grants.

A package of [wac-mono](../../README.md) — see the root README for layout and how to run things.
All commands run from the repo root.

## What works

```
deno task test packages/ssh
deno task coverage:ssh
```

The test that matters runs a real `sshd`, performs the version, KEXINIT and key exchanges
against it, and **verifies the server's host key signature over our own exchange hash**.
Everything else in the suite pins a rule; that one says the rules were read correctly.

It is a hard pass or fail, and it covers almost everything at once: the signature verifies only
if every input to the exchange hash matches what the server used — both version strings without
their line endings, both KEXINIT payloads byte for byte as sent, the host key blob, both
ephemeral public keys, and the shared secret in its mpint form. One wrong byte anywhere and
Ed25519 verification fails. The test then checks the host key is the one in `hostkey.pub`, since
a signature that verifies against a key the server also chose proves only self-consistency, and
bends a bit of H to confirm verification actually fails when it should.

It then sends NEWKEYS, derives the traffic keys, and carries on **encrypted**: an encrypted
SERVICE_REQUEST goes out and the server's EXT_INFO and SERVICE_ACCEPT come back and decrypt. That
covers the whole transport in both directions at once — a wrong key half, counter, padding rule
or sequence number and the server drops the connection rather than replying.

It then reads the client private key with its own code, signs the authentication request, and
receives `SSH_MSG_USERAUTH_SUCCESS`. A second test carries on from there: it opens a session
channel, runs `seq 1 100000; echo done >&2; exit 3`, and checks all 100,000 lines came back, that
stderr arrived separately, and that the exit status was 3.

Against OpenSSH 9.6 it negotiates `curve25519-sha256`, `ssh-ed25519` and
`chacha20-poly1305@openssh.com`.

## Why the pieces look like this

**`wire.wac`** — the six types of RFC 4251 §5. Two of them carry the mistakes:

`string` is arbitrary binary with a `uint32` length, not a C string. Host keys, signatures and the
whole key exchange are strings nested inside strings, and a reader that stops at a zero byte
truncates them silently.

`mpint` is *signed*. Leading zero bytes are stripped, and then a zero byte is added back when the
top bit of what remains is set — without which a 2048-bit RSA modulus reads as negative. Zero is
an empty string rather than one zero byte.

Reading never traps. A remote peer chooses every length on the wire, so running off the end is an
expected answer and not an internal error: `Reader.ok` latches false and every later read is a
no-op, so a caller parses a whole message and checks once at the end. A length with the top bit
set arrives in a signed `i32` as negative, which is refused rather than clamped — otherwise the
bounds check is asked for a negative count and waves it through.

**`packet.wac`** — the binary packet protocol, RFC 4253 §6. The length field is *inside* the
encryption, which is why a reader cannot know how much to read before decrypting, and why
`chacha20-poly1305@openssh.com` carries a separate key just for the length. Nothing is encrypted
yet; this is the shape the cipher slots into.

Padding is mandatory, at least 4 bytes, random, and sized so the whole packet *including the
4-byte length field* is a multiple of the cipher block size. Sizing it to align everything except
the length produces packets a server accepts until encryption starts and then rejects.

The randomness comes from the caller, because wac cannot ask the host for entropy — the same
arrangement [tls](../tls/README.md) uses.

**`version.wac`** — the line each side sends before framing exists. A server may send any number
of banner lines first, and a client that reads exactly one line works against every server that
has no banner, which during development is all of them. The CR LF is *not* part of the version
string: both versions go into the exchange hash without their line endings, and including them
produces a signature that verifies against nothing, far enough from here that the cause is not
obvious.

**`kex.wac`** — the exchange itself, and the key derivation of RFC 4253 §7.2. The exchange hash
H is the security of the whole protocol in one value: the server signs it, so a peer that cannot
produce that signature cannot have chosen any of its inputs, which is what stops an attacker in
the middle from downgrading the algorithm lists.

**K is an mpint, not 32 bytes.** The X25519 output is read as an unsigned big-endian integer and
encoded minimally, so a secret starting with a zero byte is 31 bytes on the wire and one with its
top bit set gains a leading zero. Each happens about one time in 256 — often enough to be a real
bug, rarely enough that a client written the obvious way works for a while first.

Key derivation extends by hashing **everything produced so far**, not just the previous block.
That only shows up above one hash length, and the only key we need that is longer is
chacha20-poly1305's 64 bytes, so nothing else in the protocol would catch it. Checked against a
transcription of the RFC using WebCrypto.

An all-zero shared secret means the peer sent a low-order point and every session would share the
same secret; RFC 8731 §3 requires aborting, and nothing later notices if you do not.

**`cipher.wac`** — `chacha20-poly1305@openssh.com`, which is **not** the RFC 8439 AEAD that
`crypto/src/aead.wac` implements. Same two primitives, every structural choice different:

Two keys, from 512 bits of key material — and the *first* 256 are K_2, the second K_1, which
reads backwards. K_1 encrypts only the 4-byte packet length; K_2 encrypts the payload and keys the
MAC. Swapping them round-trips perfectly against itself and fails only against a real server,
which is why there is a test asserting the halves are not interchangeable.

The length is encrypted under its own key so a reader can learn how much to read without having
decrypted anything it must then trust. The MAC covers the ciphertext — both the encrypted length
and the encrypted body — and is checked *before* anything is decrypted. None of RFC 8439's
associated-data framing appears: the MAC input is simply the bytes on the wire.

The nonce is the packet sequence number and nothing else, so the `A`/`B` and `E`/`F` key
derivation outputs go unused. The sequence number is never transmitted; both sides count, and if
they ever disagree the MAC fails with no indication of why. Strict KEX resets both counters at
NEWKEYS, which is the one place that is easy to get wrong and impossible to debug from the
symptom.

Padding here follows the **AEAD rule, not RFC 4253's**: because the length is authenticated
separately, only `padding_length || payload || padding` is aligned, not the whole packet. The two
differ by exactly 4 bytes for every length, so a test that checks "aligned to something" passes
with either.

**`kexinit.wac`** — negotiation, RFC 4253 §7.1. The rule is asymmetric: the chosen algorithm is
**the client's first preference that the server also supports**. Server order is ignored. Getting
that backwards yields a client that negotiates something plausible and disagrees with the server
about what was negotiated, which surfaces much later as a MAC failure.

The proposal is deliberately narrow — one key exchange, one host key type, one cipher — because
advertising something we cannot perform is worse than not advertising it: the server will pick it.
Two entries are not algorithms. `ext-info-c` asks for the server's extension list, which is how a
client learns `rsa-sha2-256` is available rather than the SHA-1 that `ssh-rsa` implies.
`kex-strict-c-v00@openssh.com` opts in to strict KEX, which forbids the unrelated messages the
Terrapin attack (CVE-2023-48795) used to shift sequence numbers.

**`privatekey.wac`** — the `openssh-key-v1` file format, which is not PKCS#8 and not PEM RSA.
`none` and `aes256-ctr`+`bcrypt` are read; anything else is refused by name rather than misread.

**There is no MAC over the private section.** A wrong passphrase decrypts to plausible random
bytes, and the *only* thing that notices is a random 32-bit value stored twice at the front
failing to match itself. That is a 2^-32 false accept by design, and it means the check cannot be
skipped — everything after it would otherwise be parsed out of noise. The private string is the
32-byte seed followed by the public key again; only the first half is secret.

**`auth.wac`** — publickey authentication, RFC 4252 §7. The signature covers **the session
identifier followed by the request without its signature field**, and the session id is what makes
it worth anything: without it a signature is a bearer token that a malicious server could collect
and replay to a third party as the client. The session id is length-prefixed as a `string` even
though nothing follows that could be confused with it — omitting that length produces a signature
the server rejects, indistinguishable from the key being wrong.

**`knownhosts.wac`** — deciding whether the host key we verified is the one we *expected*. The
key exchange proves the peer holds the private half of the key it presented; it says nothing about
which peer that is. Without this, a man-in-the-middle presenting its own host key produces a
perfectly valid exchange and the client proceeds.

That is worth stating precisely, because the damage is bounded but real: a publickey signature
binds to the session id, hence the exchange hash, hence the host key the attacker presented, so
the attacker **cannot** replay our signature to the real server. They do get the session, and
everything sent afterwards.

Entries come in two forms and they are parsed by completely different code. Hashing is the default
— `HashKnownHosts yes` — so a real entry is `|1|salt|HMAC-SHA-1(salt, name)`, and a client that
cannot compute that cannot read the file its user already has. (That is why `crypto` gained
`hmacSha1`; SHA-1's collision weakness is irrelevant here, since the hostname is the message and
the per-entry salt is the key.) A non-default port makes the name `[host]:port`, which is what gets
hashed — get that spelling wrong and every lookup silently reports "unknown".

This reports what the file says and decides nothing. Whether an unknown host should be accepted
and remembered, refused, or put to the user is policy and belongs where the user is. The
distinction that matters is **unknown versus changed**: unknown is every first connection, while a
known host presenting a different key is the case the file exists to catch, and must never be
quietly folded into the first.

**`channel.wac`** — the connection protocol, RFC 4254. Everything after authentication happens
inside a channel: open one, ask it to run something, read back interleaved stdout and stderr until
the far end closes it.

**Each side picks its own number for the same channel** and they need not agree. Every message
carries the *recipient's* number — the one the other side chose — so a client that echoes its own
back addresses a channel the server may not have. With a single channel numbered zero on both
sides, which is the common case, that mistake works perfectly.

**Flow control is not optional.** Each direction has a window: a byte count the sender may
transmit before it must stop, refilled only by `SSH_MSG_CHANNEL_WINDOW_ADJUST`. A client that
never adjusts reads exactly one window of output and then hangs, having done nothing that any
error reports. The default window is large, so this is invisible for short commands and a deadlock
for long ones — which is why the test runs a command whose output is many windows long and asserts
the adjustments actually happened. Credit is returned at the half-way mark: adjusting per packet
spends a packet per packet, and waiting for empty stalls the sender while the adjustment is in
flight.

**The exit status arrives as a request, not a reply** — a `CHANNEL_REQUEST` named `exit-status`
with `want_reply` false, prompted by nothing.

## The program

`src/client.wac` is the protocol as something that blocks: one struct holding the socket, the keys
and the two sequence numbers. It reads like a straight line rather than a state machine because
`packages/platform`'s sockets are synchronous — `recv` parks the wac thread while the host reads
on another. [tls](../tls/README.md) had to be a `feed(state, input)` pump precisely because it
predates that capability.

`src/ssh.wac` is the program on top. Three things it deliberately will not do:

**An unknown host is refused**, not accepted with a warning. A real client asks; asking needs a
terminal this cannot reach, since `readStdin` is the pipe the command's own input comes from and a
prompt would consume it. The refusal prints the exact line to add, and `-k` writes it — the same
decision, made deliberately rather than by pressing return. `-k` does *not* override a changed
key: adding is for unknown hosts.

**An encrypted key needs `SSH_PASSPHRASE` in the environment**, for the same reason. That is worse
than a prompt in every way except honesty.

**Both streams arrive in the order the remote command wrote them.** The server tags them and sends
them interleaved; the client puts each packet straight out, standard output through `write` and
standard error through `writeErr`. It used to buffer standard error to the end of the run and emit it
as one `warn`, because the world had no byte-level error stream: a per-packet `warn` inserted a
newline at every packet boundary, the whole-run form lost the ordering, and output that was not valid
UTF-8 was mangled by going through a string.
[Issue 0014](../../issues/closed/0014-platform-has-no-way-to-write-bytes-to-standard-error.md).

Argument joining matches OpenSSH: everything after the host becomes one command string joined with
spaces, so `ssh host sh -c 'echo hi'` loses its quotes here exactly as it does there. Verified
against the real client rather than assumed.

## The server

`src/sshd.wac` listens, authenticates and runs a command. **OpenSSH's own client connects to it
and cannot tell the difference** — until it asks for a shell.

That reversal is the point of having it. Every other test here runs our code against a real
server; this one runs a real client against ours, and exercises paths nothing else reaches: the
server offers lists a client negotiates against, *signs* an exchange hash rather than verifying
one, answers the key probe, and picks the channel number the client then uses. A second
implementation by the same author would agree with itself about a misreading; OpenSSH does not.

**The command runs in [`packages/sh`](../sh/README.md)**, so what a client sends is a shell
script rather than a name the server knows:

```sh
ssh -p 2222 user@host 'seq 1 100 | grep 7 | wc -l'
ssh -p 2222 user@host 'x="a b c"; echo "$x" | tr " " "-"'
```

Pipelines, quoting, `$(…)`, `&&` and redirection all work, because the server knows nothing about
any of them — it hands the string to a shell running in *capturing* mode, whose standard output
collects into a buffer instead of going to the server's terminal, and sends that down the channel.

**Interactive sessions work too.** A client that asks for a `shell` rather than an `exec` gets a
read-eval-print loop over the channel, with **one shell for the whole session** — a variable set
on one line is there on the next, which is what makes it a session rather than a run of unrelated
commands:

```sh
ssh -T -p 2222 user@host
x=hello
echo $x world
```

A REPL needs no concurrency, which is why this works at all with one thread: the client sends a
line and waits, so the ordinary blocking read is the right shape.

**`pty-req` is refused, deliberately.** Accepting it makes the client put its terminal in raw mode
and stop echoing locally, expecting the server to echo every keystroke — which needs terminal
modes this cannot honour, and the user would type blind. Refused, `ssh host` from a real terminal
prints `PTY allocation request failed on channel 0` and carries on with the client's own line
editing, which is the same thing a real sshd gives you when no pty is available. No prompt is
written, because without a pty a real shell is not interactive and prints none.

**It still cannot start a process, and now it never will** —
[issue 0015](../../issues/closed/0015-platform-cannot-start-a-process-so-a-server-cannot-run-a-command.md)
is closed `wontfix`, because running host programs is a non-goal. The shell's external commands are
its own, written in wac; `help` lists them. What changed is that there is a shell between the client
and them, not that there is a system underneath. That remains the *only* reason this is not an
sshd: the transport, key exchange, cipher and channel layer are the same code the client uses.

The reach is bounded by what the server was granted. With `--allow-read` alone a client can read
what the server can read and write nothing. That is a real exposure whose size the operator
chooses, which is the capability world working rather than a gap in it.

**Which channel requests get a reply is decided by the request, not by whether we understood
it.** This was wrong, and the effect was total: a client whose `ssh_config` contains
`SendEnv LANG LC_*` — the Debian and Ubuntu default — sends two `env` requests before `exec`,
both with `want_reply` *false*. The server answered them anyway, the client matched replies to
requests in order, and it attributed the first spurious answer to its `exec`. Every command
failed with `exec request failed on channel 0` while the server logged that the client had never
asked to run anything.

The suite did not see it because `test/server.test.ts` runs the client with `-F /dev/null`, which
is good hygiene for reproducibility and also discards the very config that sends the `env`. It was
found by running the server by hand and connecting to it normally, which is worth remembering: a
test that controls the client's configuration is not testing the clients that exist. There is now a
case that puts `SendEnv` back, and it fails without the fix.

**A line ends CRLF whenever the client has a terminal**, and there is no terminal driver here to
fold it, so the interactive loop strips the carriage return at a line boundary and nowhere else.
Without that, `exit\r` is not `exit`.

**`ssh -tt` — forcing a pty — does not give a usable session**, which follows from `pty-req`
being refused rather than being a separate defect: the client prints `PTY allocation request
failed` and gives up. `ssh -T` and an ordinary terminal session both work.

Three server-side details that a client never has to get right:

**A publickey request with no signature is a probe** — the client asking whether a key is worth
signing with. Answering `SSH_MSG_USERAUTH_FAILURE` is not wrong on its face, since the client is
indeed not authenticated, but it tells the client the key is refused, so it moves on and reports
`Permission denied (publickey)` for a key the server would have accepted. `SSH_MSG_USERAUTH_PK_OK`
is what makes it sign.

**A channel closes when both ends have said so.** Closing the socket after our own
`CHANNEL_CLOSE` makes the client report a clean session end as `Connection closed by remote host`.
Sending `SSH_MSG_DISCONNECT` instead is worse: the client treats it as abnormal, throws away
output it has not read, and exits 255. Both were observed before the third version — waiting for
the client's close — was right. `DISCONNECT` is for refusals, where there is nothing left to
deliver.

**`C` is client-to-server**, so the server reads with C and writes with D — the opposite of the
client. It is the one asymmetry whose consequence is a connection where nothing decrypts at all,
which at least fails immediately.

`src/authorizedkeys.wac` parses the options field respecting quotes, because `command="echo hello
world"` contains spaces that do not end it — and a naive scan finds a key type where there is
none, which reads as "this line is not for you" and lets a *restricted* key through as unknown.
Options are then refused rather than obeyed: a server that reads a restriction and ignores it is
worse than one that refuses, because the operator wrote it expecting it to hold.

## How this is tested, and what the numbers mean

Three oracles, because no one of them sees enough.

**A real OpenSSH server** for the client (`test/transport.test.ts`, `test/cli.test.ts`) and **a
real OpenSSH client** for the server (`test/server.test.ts`). That reversal is the point: every
other test here runs our code against theirs, and the server tests run theirs against ours, which
reaches the paths nothing else does — offering lists rather than choosing from them, signing an
exchange hash rather than verifying one, answering the key probe.

**The RFCs, directly**, wherever a value has no oracle inside the package. All 25 message numbers
are asserted against RFC 4250 §4.1.2, and the refusal messages byte for byte against RFC 4254 and
4253. That is not belt-and-braces: a function returning a constant is compared only against itself
here — `parse` reads a byte and checks it against `msgChannelEof()` — so a wrong number makes
both sides wrong together and every interop test still passes.

**Mutation testing**, `deno task mutate --package ssh --operators`, about eleven minutes:

```
135/151 killed, 3 survived, 13 not covered
```

**The three survivors are deliberate and should stay.** Anyone re-running this needs to know
that, or they will read a regression:

- `extreme/ssh/ssh/defaultPort` and `extreme/ssh/sshd/defaultPort` — unexported constants in
  program entry files, 22 and 2222. Reaching them means binding those ports in a shared suite,
  and buying a flake to pin a constant whose failure is immediately obvious is a bad trade.
- `guard/ssh/sshd:231:37` — the length check in `hostPublicPoint`. It is now genuinely
  unreachable, *because* `readEd25519` validates the outer public blob; it guards an invariant
  maintained in another file, which is the kind worth keeping.

The 13 "not covered" are mostly length preconditions on internal helpers — `if (key.len() !=
keyLength()) { trap; }` and the like. Note that "not covered" here means **not covered by the
attributable tests**: the profiler only sees in-process `wacBind` tests, so anything exercised
solely by the two integration suites reads as uncovered when it is not. See
[issue 0024](../../issues/open/0024-mutation-selection-is-inert-for-subprocess-tests-and-the-fallback-runs-them-worst-first.md).

There is a design rule underneath those guards worth stating, because it is easy to break by
accident: **a `trap` guards our own invariants; anything a peer supplies is handled with a
nullable return instead.** `sharedSecret` takes the client's point and answers `u8[]?` because a
bad point is the peer's doing, not a bug. The one place that was violated — `hostPublicPoint`
trapping on data read from a *file* — was a real defect, and the fix was to validate at the parse
boundary rather than to soften the trap.

## What is missing

A client state machine for library use — `src/client.wac` blocks, which suits a program and not a
caller that wants to drive I/O itself. Everything above is a set of functions over bytes, driven from the test —
which is the right shape for testing each rule against a real server, and the wrong shape for a
caller who just wants to run a command. `packages/tls` shows what the answer looks like: one
`cliFeed(state, input)` returning what to send, with the socket and randomness in the host.

Also absent, and worth naming rather than leaving implied: rekeying is not implemented, so a
long-lived or high-volume connection would run past the point where it is required. There is no
authentication method other than publickey with Ed25519 — no password, no keyboard-interactive, no
agent. Host certificates (`@cert-authority` lines) are recognised well enough to be skipped rather
than misread, but not validated.

`known_hosts` is a byte comparison against the host key blob, so there is no X.509 and no chain
building — which is the main reason this is a smaller job than the TLS client already in the repo.
