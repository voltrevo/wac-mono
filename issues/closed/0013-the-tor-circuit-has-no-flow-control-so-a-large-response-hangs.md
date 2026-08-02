# 0013 — the tor circuit has no flow control, so a large response hangs

- **Status:** closed 2026-08-02 by agent-c
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

## Closed

Both windows, both directions, in `host/circuit.ts`. Circuit-level SENDMEs are the
authenticated version-1 form.

**A correction to this issue's own numbers.** It said the ceiling was about 249KB, taken
from the 500-cell stream window. That is wrong for the case that matters: the stream window
resets with each new stream, so the binding limit is the circuit's 1000 cells — about 498KB.
The first measurement after implementing this reached 814 cells and reported success against
the 249KB figure, which would have been a false pass. Re-run properly it carried 2508 data
cells and 1.2MB over 209 streams on one circuit: 2.5x the window, which cannot happen
without SENDMEs being accepted.

**The digest is the fiddly part.** A version-1 circuit SENDME carries the running backward
digest at the point the acknowledged cell arrived, so a relay cannot invent credit — only
someone who actually received the cells knows that value. It is captured when the deliver
window reaches a multiple of the increment, which is one cell *before* the SENDME goes out;
recording it when the SENDME is built gives a value one cell too late.

Verified in both directions against a real tor relay. With the correct digest, 2508 cells
flowed. With one bit flipped in it, the relay destroyed the circuit at 108 cells — reason 1,
protocol violation, immediately after the first SENDME at 100. So tor does check it and ours
is byte-correct, which the positive result alone could not have established.

**Known limitation, deliberately not hidden.** `#spend` throws rather than blocking if the
send window empties while a cell is already waiting to be read, because draining the read
side mid-write would reorder what the caller sees. A client that both uploads more than 1000
cells and reads concurrently needs a proper reader loop; one that fetches does not.
