# tor

A Tor client, in wac, on top of this repo's TLS 1.3 stack.

It builds circuits. Against a local chutney testnet it does the link handshake, negotiates
link protocol 5, runs ntor, extends to three hops, opens a stream and fetches a consensus
over it — every layer ours, from the TLS 1.3 record up.

The consensus is verified before any of that happens: a majority of the directory
authorities must have signed it, checked against identity fingerprints the caller supplies
out of band, and it must be inside its validity window.

Flow control works, including authenticated SENDMEs: 1.2MB over 209 streams on one circuit,
2.5x the circuit window.

It bootstraps over Tor: a one-hop circuit to a starting relay fetches the consensus,
certificates and microdescriptors, verifies them, and every circuit after that is chosen
from what it learnt — bandwidth-weighted per position, distinct /16s, mutual families
excluded, an exit whose policy carries the port, through a pinned guard set.

There is a **SOCKS5 proxy**: `src/socks.wac`, so `curl --socks5-hostname` and anything else
that speaks SOCKS goes over Tor. It keeps a circuit per destination port, built on demand and
all sharing one pinned guard, and every connection becomes a stream on the circuit for its
port. Against the testnet it has carried 3.2MB across eight concurrent streams, byte-identical,
and 400KB back the other way.

Built, it is **386.7 KiB** as a self-contained executable — 234.2 KiB of wasm, 71.8 KiB
gzipped — of which the proxy costs 14.4 KiB over the fetch-and-exit program.

It should still not be pointed at the real network — see *What is not here*.

## Why this is possible at all

Tor needs Curve25519, SHA-256, HMAC, HKDF, AES-128-CTR, Ed25519 and a TLS client, and all
of those already exist here — the TLS work built them. The only primitive that had to be
added is **SHA-1**, which Tor still specifies for the running digest that authenticates a
circuit's relay cells. Nothing should choose SHA-1 today; a client that wants to talk to
the network implements what the network speaks.

## ntor

`src/ntor.wac`, from tor-spec §5.1.4. A one-and-a-half round trip authenticated key
exchange out of nothing but Curve25519 and HMAC-SHA256.

Two Diffie-Hellmans, and the distinction is the whole design. `EXP(Y,x)` between the two
ephemeral keys gives forward secrecy; `EXP(B,x)` against the relay's published onion key is
what makes the exchange *authenticated*. Drop either and the handshake still completes and
still agrees a key — the first silently loses forward secrecy, the second lets anyone on
the path impersonate the relay — so a round-trip test cannot tell the difference, and the
tests remove each contribution in turn.

A small-order `Y` makes the shared value all zero for every scalar, so an attacker holding
no private key derives the same keys the client does. tor-spec says abort; `ntorClientFinish`
returns an empty array rather than keys plus a boolean, because a boolean invites using the
keys anyway.

## How it is tested

Five tests are relations between the handshake's own outputs, and one is a differential
against **tor's own C implementation** — `test-ntor-cl server1`, built by `tools/tor.sh`.
That last one is the only test that could notice all the others being consistently wrong,
and it checks byte-identical key material rather than mere agreement.

tor's answers are **committed** as vectors in `test/data/ntor_vectors.json`, so that
differential runs on any machine with no binary and no network. When the binary is present
its live answer is used instead, so the check also sees changes in tor.

It did not start that way, and the failure is worth recording. The test used to shell out to
the binary and fail when it was missing — right principle, since a differential that
silently stops running leaves everything green while checking nothing. But the binary lived
in `/tmp`, and when the container was recreated the fixture vanished and this package turned
the shared suite red for three agents who had not touched it. "Fail forever" is not the fix
for "might silently stop running"; durable is.

A recorded answer is not the weaker option here. Each vector is a complete (reply, keys)
pair that tor produced, and the assertion is that our client derives *those keys* from *that
reply* — the same assertion either way. The vector is an input from tor, not an expected
output of ours. Note also that tor picks a fresh ephemeral key per handshake, so its reply
differs every run: there is deliberately no recorded-versus-live comparison, because it
would fail constantly and detect nothing.

Regenerate with `TOR_NTOR_REGEN=1 deno test -A packages/tor/test/ntor_wac.test.ts` after
building with `tools/tor.sh`. The binary is looked for under `$HOME/tor-build`, not `/tmp`.

## The layers, and where each lives

| | |
| --- | --- |
| `src/cell.wac` | cell framing, VERSIONS, NETINFO, CREATE2/CREATED2, padding |
| `src/ntor.wac` | the handshake |
| `src/relay.wac` | relay cells: the running digest, the onion layers, EXTEND2 |
| `src/circuit.wac` | the circuit: layering, windows, streams — a state machine over cells |
| `src/directory.wac` | parsing a consensus and its microdescriptors |
| `src/consensus.wac` | the authority chain, the majority rule, freshness |
| `src/pathsel.wac` | bandwidth weighting, families, guards, exit policies |
| `src/pool.wac` | circuit reuse and retirement |
| `src/dirclient.wac` | request paths and the refresh schedule |
| `src/link.wac` | a TLS link to a relay, and cells over it — TLS record framing lives here |
| `src/bootstrap.wac` | a verified consensus, and building circuits through a pinned guard |
| `src/socks5.wac` | SOCKS5 as pure functions: a request in, a target or a refusal out |
| `src/app.wac` | a program: fetch one path over a fresh circuit and exit |
| `src/socks.wac` | a program: the SOCKS5 proxy |

The two programs are thin — `app.wac` is 77 lines — because everything they share was moved
below them. It did not start that way: `app.wac` was 510 lines with the whole client inside
`main`, which was fine until there was a second program and none of it could be reused.

There is no `host/` directory. There was, and it was 1368 lines against 722 of wac — in a
repo where `tls` is 0.17x TypeScript and `ssh`, a client and a server, is zero. The excuse
was that the host owns the socket, and it was already false: platform sockets landed
seventeen minutes before the first of those files was written, and `box gets` was already
doing TLS 1.3 in wac over one.

The split is the same one the TLS package uses: bytes and state machines in wac, and only
the socket in TypeScript. One exception is forced rather than chosen — a `Hop` is a struct
and structs do not cross bindgen, so the hop state crosses as a 290-byte blob and comes back
with every call.

## Believing the directory

`parseConsensus` reads a document; `relaysFromVerified` decides whether to believe one. Use
the second. The chain:

```
authority identity fingerprint   supplied by the caller, out of band
  -> key certificate             identity key must hash to that fingerprint,
                                 and must itself have signed the signing key
    -> consensus signature       made by a signing key certified that way
      -> majority                more than half the named authorities
        -> freshness             inside valid-after .. valid-until
```

A real client compiles the fingerprints in. This takes them as an argument, which is the
same thing said honestly — a caller that reads them out of the directory it is checking has
verified nothing.

Two details that would each produce a verifier passing every positive test:

**Tor's signatures carry no DigestInfo.** `rsaVerifyPkcs1` requires the DER structure naming
the algorithm, which is what stops Bleichenbacher '06. Tor pads a bare digest and nothing
else, so this uses `rsaRecoverPkcs1` and compares the payload itself — whole, against a
value of known length, never searched within.

**The signed portion ends mid-line**, at `directory-signature ` inclusive of the trailing
space, with the signatures outside it. The leading newline in that search is load-bearing.

## Measured against the real network

The testnet is five relays on 127.0.0.1. The real consensus is 9566 relays, 3.26MB, with
36MB of microdescriptors and 458762 mutual family edges — and running against a captured
copy of it found something no amount of testnet work could:

| | before | after |
| --- | --- | --- |
| `parseConsensus` | 47ms | 47ms |
| `attachMicrodescriptors` | 852ms | 739ms |
| `resolveFamilies` | **11039ms** | **379ms** |
| a path, after setup | | 13ms |

Both slow paths were the same mistake: resolving a name by scanning every relay. That is
fine at five relays and ruinous at ten thousand, and it is invisible on a network small
enough to develop against. An index built once turns each lookup into a hash.

Eleven seconds on every bootstrap would not have been a subtle degradation — it is the
difference between a usable client and one nobody would run. Worth remembering that the
testnet cannot show it, and neither can any test written against the testnet.

`audit/audit.ts` is the same idea for *behaviour* rather than speed, and it found the other
thing the testnet could not. The authorities publish nineteen bandwidth weights and `Wge` is
not among them; tor hardcodes `We = 0` for the guard position. This defaulted it to 10000
with the rest — invisible, because `eligible` rejects a relay without the Guard flag before
the weight is consulted, so two independent things gave the same answer. The day the flag
check moves, the weight is what would have been holding the line, and at 10000 it would not
have been.

What the audit reports on a real consensus, all as it should be:

- all eighteen published weights parsed, `Wgg=5983` rather than the neutral default
- guard selection matches the weighted bandwidths to within sampling noise across every
  decile of weight — 0.997, 1.000, 1.016, … for the deciles that carry the mass
- no relay with zero weight ever chosen
- 5341 relays in a family, the largest 357 members, 3.7% of the network
- paths build 200 out of 200 for ports 443, 80, 22 and 25, always three distinct addresses,
  though port 25 has only 108 usable exits — mail is widely refused

## Choosing a path

The part whose failures are silent. A wrong handshake breaks the circuit; a wrong path
selection builds a working circuit with the anonymity quietly removed.

**Weighted by bandwidth, per position.** Uniform selection sounds fair and is not — capacity
is enormously unequal, so it sends most traffic through relays that cannot carry it and lets
an attacker buy influence with relay *count* rather than with bandwidth. But plain bandwidth
is wrong too, because exit capacity is scarce and must not be spent in the middle position.
The consensus publishes a weight per (flag combination, position) pair for exactly this, and
a client that ignores them concentrates its traffic differently from everyone else's, which
is itself distinguishing.

**Distinct /16s and mutual families.** Two relays in one /16 are plausibly one wire. Family
declarations must be mutual — A listing B means nothing unless B lists A — because otherwise
anyone could shrink your candidate set by claiming kinship with relays they do not run.

**A pinned guard.** With a fresh first hop every circuit, an adversary running a fraction of
the network sees your entry *eventually*, with probability approaching one. Pinning turns
that into a single sample. So a guard set that rotates is not a guard set, and in particular
failure must not cause rotation — otherwise blocking someone's guards is how you get chosen
as the replacement. `currentGuard` skips a failed guard, retries it in an hour, and never
samples a new one to replace it.

The chooser takes its randomness as an argument. That is what lets the tests sweep the whole
random space and assert the distribution exactly, instead of sampling it — a statistical
test loose enough never to flake is loose enough to miss a real bias.

## HTTPS over Tor

Point any HTTPS client at the SOCKS port:

```sh
deno task app packages/tor/src/socks.wac --allow-net --allow-read -- seed.txt auth.txt 9050
curl --socks5-hostname 127.0.0.1:9050 https://example.com/
```

**`--socks5-hostname` and not `--socks5`.** The two differ by who resolves the name. With
`--socks5` curl resolves it locally first, in plaintext, over whatever network it is on —
which announces the destination before a single byte enters the circuit, and nothing later
undoes it. The proxy carries both, because refusing an address would break clients that
cannot be fixed from here, but only one of these is private.

There used to be an in-process route as well — `torFetch(pool, "https://…")`, a `TorSocket`
shaped like a `Deno.Conn` so that `packages/http`'s existing request loop worked over a Tor
stream with no adapter. It went when the TypeScript went, and it is worth recording what it
demonstrated, because the point outlived the code: the socket shape was the whole
integration. Anything more than matching it was a sign of not having looked for the loop
that already existed.

The SOCKS proxy is the same idea one level down. Instead of matching `Deno.Conn` so one
runtime's clients work, it matches a protocol so every client does, in any language, with no
code here at all.

**The exit is the adversary, so certificate validation matters here.** Everywhere else in
this package the trust store is deliberately empty — a relay is authenticated by ntor, not
by its self-signed certificate. This is the opposite case: the exit sees plaintext TCP, can
be anybody, and exits that tamper are observed rather than hypothetical. Tor with an
unvalidated end-to-end TLS is worse than no Tor, because it takes a connection your ISP
could read and hands it to a stranger who chose to be there.

A SOCKS proxy cannot enforce that — it carries bytes and never sees whether they are TLS.
`torFetch` used to refuse `http://` outright; nothing does now, and the responsibility has
moved to the client. Use `https://`.

## Bootstrapping is not circular

To build a circuit you need relay keys; to get relay keys you need the directory; to fetch
the directory privately you want a circuit. It resolves because the first fetch does not
need to be private. The consensus is a public document every client has, and downloading it
reveals only that you are a Tor user — which connecting to a relay revealed anyway.

What matters is that the download's *source* is irrelevant, and that is what verification
buys. `bootstrap` takes one starting relay (a real client's hardcoded fallback mirror),
fetches over a one-hop circuit, and refuses anything a majority of authorities did not sign.

## Exit policies

Chosen for the port, not just the flag. A microdescriptor's `p` line is a summary like
`accept 80,443` or `reject 25,119`, and getting the polarity backwards sends traffic to
exactly the exits that will refuse it — which looks like a flaky network, since the client
just retries elsewhere.

**A missing `p` line means reject-all**, matching tor. The Exit flag says the authorities saw
the relay exit *something*; the summary says what. Reading a missing summary generously would
send streams to relays that refuse them.

## Circuits are reused, and retired

Reuse saves three handshakes. That is not why it needs care — "reuse the circuit" and "keep
the circuit forever" are one step apart, and the second is a real leak: everything on one
circuit shares an exit, and the exit sees every destination. A circuit that lives all day
hands one relay the whole day's activity, linked as one person's.

So a circuit stops accepting *new* streams ten minutes after its first one (tor's
MaxCircuitDirtiness). A download already running keeps its circuit; what stops is anything
else joining it.

**Isolation is the caller's call.** Two streams that must not be linked must not share a
circuit, and only the application knows which those are — tor's own default isolates by
client address and SOCKS credentials but deliberately *not* by destination, because a
circuit per site would build faster than the network absorbs. Tor Browser layers
first-party-domain isolation on top. `CircuitPool` guarantees two isolation keys never share
and does not invent one.

## Keeping the directory current

`Directory` refreshes at a random time between `fresh-until` and three quarters of the way to
`valid-until`. Random because every client refreshing at one instant is both a herd on the
caches and a fingerprint; three quarters because the last quarter is slack for a failed
download to be retried before anything expires.

A failed refresh keeps the old consensus rather than falling back to anything unverified —
an attacker who can break your directory fetches should get a client on stale but genuine
data, not one that believes the next thing it is handed. Past `valid-until` with no
replacement, `chooser()` throws rather than building paths from a retired document.

## Link padding

A client's connection to its guard is long-lived and mostly idle, and a middlebox keeping
netflow records reads each idle gap as the connection ending and a new one starting. That
record — when your connection to a guard began and ended — is exactly the timing an
end-to-end correlation attack wants, and it is collected by default on a great many networks
by equipment nobody thinks of as an adversary. Padding keeps the flow open.

**It defends against flow records and nothing else.** A padding cell is the same 514 bytes
as every other cell, so an observer on the wire counts them identically. It is not the
circuit-level padding that defends against website fingerprinting — that is WTF-PAD,
negotiated per circuit with RELAY_DROP cells, and it is not here. Confusing the two is how a
narrow defence becomes a false sense of a broad one.

Two things worth knowing, both learnt from a real relay rather than from the spec:

- **The negotiated range is a floor.** tor takes `MAX(consensus, negotiated)` for both
  bounds, so a client can ask for *less* padding than the 1500–9500ms default and never for
  more. Asking for 1500–3000 and watching the relay pad at seven-second intervals is what
  sent me to read `channelpadding_get_netflow_inactive_timeout_ms`.
- **A relay only pads a channel it considers in use** — one carrying full circuits or user
  traffic. Negotiating on a bare link and waiting produces nothing, which looks exactly like
  the negotiation having failed.

Verified against tor: the relay logs `Negotiated padding=1, lo=1500, hi=3000`, and once a
three-hop circuit exists, padding cells arrive.

## Fuzzing found a remote crash

`test/wac/fuzz_test.wac` feeds every parser bytes a relay chose: cell framing, relay cell
bodies, consensus and microdescriptor text, HTTP responses, the small length-prefixed
decoders. It found one real bug on the first run.

A relay cell body carries a two-byte length field, which reaches 65535 while the body holds
498. `relayPayload` trapped on the difference, and `Circuit.receive` calls it on every
recognised cell — so a single malformed cell from a hop in our own path aborted the client.
`decodeCreated2` and `extended2Reply` had the same shape.

The lesson is not the arithmetic, it is who gets to choose. A hop is authenticated by ntor,
and authenticated is not friendly: it is a stranger from a public directory, and it is
exactly the adversary the three-hop design assumes. All three are total functions now, and a
bad length is a dead circuit rather than a dead process.

**wac made this a crash rather than a disclosure.** Bounds checks turn a length-field bug
into a deterministic abort instead of a read into whatever is next in memory — a real
advantage over the C this protocol is usually written in, and still not something to leave
reachable.

The generator is a deterministic PRNG, because a fuzz test that finds something on Tuesday
and cannot reproduce it on Wednesday is a rumour.

## Relay cells, and the two things that are easy to get wrong

**The digest is a running hash, not a per-cell one.** Each direction has a SHA-1 seeded at
the handshake and updated with every relay cell's payload, digest field zeroed. So a cell
that fails to verify cannot be skipped — its bytes are already in the sender's hash, and
ignoring it desynchronises everything after it. And a cell that turns out not to belong to
a hop must leave that hop's hash untouched, which is why `Sha1` grew a `clone`.

**The keystream is continuous, not per-cell.** A cell payload is 509 bytes, which is not a
multiple of the AES block, so each cell starts part-way into a block the last one began.
`aesCtr` starts from the counter it is given and is therefore the wrong shape entirely;
`CtrStream` in the crypto package is the right one.

## A warning about the relay tests

`test/wac/relay_test.wac` builds the relay side by reading the same key material with the
directions swapped, which makes a genuine round trip. It is a real oracle for the
**Df/Db/Kf/Kb split** and no oracle at all for the cipher and hash underneath, because both
ends run the same code — break either identically at both ends and every test still passes.
Stopping the CTR counter from advancing was tried and that file did not notice.

What catches it is in the crypto package, where a chunked `CtrStream` is compared against
the one-shot that the host's own AES already verifies. If you add a relay test, ask which
of those two kinds it is.

## The SOCKS proxy

`src/socks.wac` is one worker holding one outstanding `recv` per socket plus an `accept`,
handing the whole list to `waitAny` and re-issuing whichever answered. `box nc` is the
two-handle version of the same shape.

**Circuits are per port, on one pinned guard.** A circuit is built when the first client asks
for a port and reused by everyone after; clients arriving mid-build park and get their
`RELAY_BEGIN` when the last hop answers. Every circuit runs over the *same* TLS connection to
the *same* guard, told apart by the circuit id in each cell's header, because that is what a
guard is for — a client should present the network one entry point, not a fresh one per
destination.

Choosing the exit for the port that was actually asked for is the point. An exit picked before
anyone has asked may refuse the first thing they want, and by then three handshakes have been
spent finding out.

Sharing a link means the build cannot block. `bootstrap.wac` has both: `buildCircuit` sits in
`nextCell` until each handshake answers, which is right for `app.wac`, which owns its link;
`startCircuit`/`advanceCircuit` are a state machine the caller drives one cell at a time,
because a blocking build on a shared link would swallow cells belonging to other circuits and
advance the wrong ciphers — from which there is no recovering.

**A guard that leaves no exit is not a guard.** The exit is chosen excluding the guard, so a
relay that is the only usable exit leaves nothing to exit through if it is also the entrance,
and every circuit then fails at path selection rather than on the wire. `connectGuard` checks
before pinning. Real tor never notices this because it keeps several guards and the network
has thousands of exits; the testnet here has five relays and exactly one exit, so it happened
on the first run that drew badly.

## The bug the proxy found immediately

Uploads are the interesting direction. Tor's package window bounds what may be in flight, so
a client that uploads faster than credit arrives will outrun the circuit, and the choice is
to buffer without limit or to stop reading. It stops reading — the outstanding `recv` is not
re-issued until the queue drains below 32KB — which pushes the problem back to the client,
where it can be solved.

**The first real transfer through it aborted the client**, and the bug was older than the
proxy. `tlsClientFeed` takes whole records and says so in its own comment; it does no
buffering by design, so that only one place decides where a record ends. `link.wac` had been
handing it whatever `recv` returned since the day it was written.

It worked for a year of directory fetches because a consensus arrives as a few small records
that a TCP segment does not usually split. The proxy's first 400KB download arrived as 44KB
in one chunk — some eighty records with the last one cut in half — and it trapped. This is
the failure mode that shows up on a *fast* connection rather than a slow one, which is the
opposite of where you look.

`box/src/applets/gets.wac` had the framing right the whole time, with the reason in a comment
next to it. Two of this repo's TLS callers, one correct and one not, and nothing compared
them. The fix is `wholeRecordBytes` in `link.wac`, and the test feeds it every prefix of a
record and the exact eighty-records-plus-a-split-one shape that failed.

## What is not here

**The real network.** Directory authorities are reached by IP and this sandbox's proxy
allowlist is by domain, so they answer 403; torproject.org is blocked outright. Everything
here is verified offline or against a locally built tor.

**Concurrent read and write past the send window.** `#spend` throws rather than blocking if
the send window empties while a cell is waiting to be read, since draining the read side
mid-write would reorder what the caller sees. A client that uploads more than 1000 cells
while reading needs a proper reader loop; one that fetches does not.

**The guard algorithm is still partial.** It has the two properties that matter — no
rotation on failure, and no rotation when every guard fails at once, which is read as the
network being down rather than as three dead relays. Proposal 271 also ages entries out of
the sampled set on a schedule, keeps a confirmed list separate from a primary list, and
bounds how much of the network a client may ever have sampled. Those are not here.

**Circuits are not built ahead of demand.** A real client keeps clean circuits ready so a
stream does not wait three handshakes. Here the first stream after a retirement pays for the
rebuild.

**No circuit-level padding.** Link padding is implemented; WTF-PAD — the padding machines
that defend against website fingerprinting — is not. Cell timing and volume within a circuit
are exactly what the application produced.

**Streams and ports under one isolation key.** The exit is chosen for the port of the stream
that caused the circuit to be built. A caller mixing ports under one key can be handed an
exit that refuses a later one.

**Isolation is by port, not by destination.** Two sites on port 443 share a circuit and so
share an exit, which is enough to link them. Tor's default is stronger — it isolates by SOCKS
credential, so a client that wants separation can ask for it — and neither that nor
`IsolateDestAddr` is here. Port is the coarsest useful key and the one the exit policy forces
anyway.

**A circuit that dies takes its streams with it.** The clients on it are dropped and the
circuit is marked failed so nothing new lands there; the next request for that port builds a
fresh one. What is not done is reattaching an in-flight stream, and deliberately: a stream
silently moved to a different exit is a stream whose destination has quietly changed hands.

**Circuits are retired for space, not for age.** An idle circuit is destroyed to make room
when the table is full, which is what stops six requests for six ports wedging the proxy for
good. There is no `MaxCircuitDirtiness`: a busy port keeps the same path for as long as the
process runs, so a long session is linkable to itself. `pool.wac` has the age logic and the
proxy does not use it.

**No SOCKS authentication, and no isolation by credential.** Tor uses the SOCKS username and
password as an isolation key — different credentials get different circuits, which is how
Tor Browser separates tabs. Here the greeting is answered "no authentication" without reading
what was offered.
