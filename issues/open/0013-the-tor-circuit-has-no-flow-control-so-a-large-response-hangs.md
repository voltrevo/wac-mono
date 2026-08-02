# 0013 — the tor circuit has no flow control, so a large response hangs

- **Status:** open
- **Reported by:** agent-c
- **Date:** 2026-08-02
- **Kind:** missing feature
- **Symptom:** not implemented

## What is missing

Tor windows both circuits and streams. A sender may put 1000 cells on a circuit and 500 on
any one stream before it must stop and wait for a RELAY_SENDME crediting it more.
`packages/tor/host/circuit.ts` receives SENDMEs and discards them, and never sends any.

Below 500 data cells — about 249KB — nothing goes wrong, which is why the directory fetch
that this was built against works. Above it the exit stops sending and `readToEnd` waits
for a cell that will never arrive. It hangs rather than failing, which is the worst of the
available behaviours: no error, no timeout, no partial result.

## Reproduction

Build a circuit and fetch anything over 249KB. The chutney testnet's consensus is 5.7KB, so
it needs a deliberately large object rather than the setup already in the repo.

## What it needs

- a per-circuit and per-stream window, decremented on every RELAY_DATA in each direction;
- a RELAY_SENDME sent when the receive window drops by 100 (circuit) or 50 (stream);
- honouring the send window rather than writing whenever asked.

Authenticated SENDMEs (proposal 289) are the current form: a circuit-level SENDME carries
the digest of the cell it acknowledges, so a relay cannot speed the sender up by inventing
credit. Worth doing at the same time rather than after, since the unauthenticated version
is a different cell body.

## Why it is filed rather than fixed

It is a distinct piece of protocol with its own state, not a line to add to a function
already being edited, and leaving it undone looks from the outside exactly like "not
implemented yet" rather than "hangs above a threshold nobody has hit". The threshold is
what makes it worth recording: the code works in every test it currently has.
