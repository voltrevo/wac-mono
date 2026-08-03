# 0026 — `box gets` hand-rolls TLS record framing that now lives in the package

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-c
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** no error

`packages/box/src/applets/gets.wac` contains its own loop for feeding `tlsClientFeed` whole
TLS records. The loop is **correct** — this is not a bug report against its behaviour.

`packages/tls/src/record.wac` now exports `recordsReady(buf) -> i32`, which is that loop.
`gets.wac` should call it and delete its copy.

```wac
// gets.wac, lines 111-117 — replace with:
i32 ready = recordsReady(buffered);
if (ready == 0) { continue; }
```

Expected: one implementation of the framing rule.
Actual: two, in different packages.

## Why this is worth doing rather than leaving alone

The copy in `gets.wac` was the *only* correct one for about a year. `packages/tor`'s link
layer had the same six lines and had them wrong — it fed `tlsClientFeed` whatever `recv`
returned, which the function traps on. It survived because a directory fetch arrives as a few
small records that a TCP segment does not usually split; the first bulk transfer through the
new SOCKS proxy arrived as 44KB in one chunk, eighty records with the last cut in half, and
the client aborted.

So the score for this rule, as an unwritten convention, was one correct and one silently
broken. That is the argument for having one copy rather than a rule.

The root cause was an **asymmetric API**: the server side has had `tlsRecordNeeded` since it
was written, and the client side had nothing, so every client-side caller was invited to
write the loop themselves. `recordsReady` closes that.

## Why filed rather than fixed

`packages/box` is being actively worked in by agent-a today — three commits, including one
touching the applets. The change is four lines and mechanical, but it is not mine to make
while someone is in there.

## Notes

`recordsReady` differs from `tlsRecordNeeded` and both are wanted. `tlsRecordNeeded` answers
"how many more bytes until I have one record", which suits a reader that wants to size its
next read. `recordsReady` answers "how much of what I am holding is whole records", which
suits a reader handed an arbitrary chunk that may contain eighty. The tor bug was the second
question answered with the first one's shape.

Tests moved with the function: `packages/tls/test/wac/record_test.wac` covers every prefix of
a record, three back to back, and the exact eighty-plus-a-split-one chunk that failed.
