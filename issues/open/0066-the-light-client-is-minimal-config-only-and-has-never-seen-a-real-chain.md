# 0066 — the light client is minimal-config only and has never seen a real chain

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b
- **Date:** 2026-08-05
- **Kind:** missing feature
- **Symptom:** not implemented

`packages/lightclient` implements the Altair sync protocol and passes all four of Ethereum's
`light_client/sync` cases (0064). Two things it does not do, split out of 0064 so that issue could
close on what it actually delivered.

## Minimal config is hardcoded

`src/store.wac` fixes `SLOTS_PER_SYNC_COMMITTEE_PERIOD = 64`, `UPDATE_TIMEOUT = 64`, and
`altairForkVersion()` = `0x01000001`, and calls `beaconTypesMinimal()` — a 32-member committee. On
mainnet those are 8192, 8192, `0x01000000` and 512.

The arithmetic is identical; only the constants move. `packages/ssz` already parameterises the
committee size (`beaconTypes(i32 syncCommitteeSize)`), so the shape exists. The reason it was not
done is that **there is no oracle**: Ethereum publishes sync-protocol vectors for `minimal` only, so
a mainnet build would be untested code that looks tested. Doing this properly means doing the second
half below, which supplies the oracle.

Not a hypothetical difference: the same signature must **fail** under mainnet's fork version, which
`test/domain_wac.test.ts` already asserts.

## The fork schedule

Everything after Altair — Bellatrix, Capella, Deneb, Electra — changes `LightClientHeader` (it gains
an execution payload header and a branch) and Electra moves the generalized indices from 54/55/105 to
86/87/169. `packages/ssz/test/proof_wac.test.ts` already carries proofs at both sets, so the ssz side
is ready; the client picks one from the slot and does not yet.

A client that cannot cross a fork boundary cannot follow mainnet for more than one fork.

## Following the real chain

Fetch `/eth/v1/beacon/light_client/bootstrap/{root}` and `/eth/v1/beacon/light_client/updates` from a
public beacon API over `packages/tls` and `packages/http`, and sync. That is the test that this is a
light client rather than a vector replayer, and it is the only way to get mainnet coverage.

Needs a domain on the proxy allowlist — worth asking the operator for now that the offline half is
known to work, which was the condition 0064 set for making the request.

## Sequence

The fork schedule is the prerequisite for the other two: mainnet's current head is Electra, so a
client that only speaks Altair cannot sync from a live endpoint regardless of its constants.
