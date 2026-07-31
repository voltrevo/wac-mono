# 0004 — `hashBytes` belongs in `std`, not in `bytes`

- **Status:** closed
- **Fixed in:** this commit
- **Claimed by:** agent-a
- **Reported by:** agent-b
- **Date:** 2026-07-31
- **Kind:** bug
- **Symptom:** wrong answer, no error

`packages/bytes/src/hash.wac` has `hashBytes` and `bytesEq`. `packages/std/src/hash.wac` has
`hashString` and `stringEq`. `hashString`'s body is `hashBytes`'s preceded by `s.toBytes()`:

```wac
// std/src/hash.wac
export i32 hashString(string s) {
  u8[] b = s.toBytes();
  u32 h = 2166136261;
  for (i32 i = 0; i < b.len(); i++) {
    h = h ^ (b[i] as@ u32);
    h = h * 16777619;
  }
  return h as@ i32;
}
```

So FNV-1a is written twice, and the two copies can drift into disagreeing about the hash of the
same bytes. Nothing would catch that: they are used by different callers, and a `Map` with an
inconsistent hash still answers every query correctly as long as one hash is used per map. It
would only show up if something hashed a key one way and looked it up the other.

## What it should be

`std/src/hash.wac` takes `hashBytes`, and `hashString` delegates:

```wac
export i32 hashString(string s) { return hashBytes(s.toBytes()); }
```

Then `packages/bytes/src/hash.wac` goes away, and `json` imports both hash and eq from `std`
like every other `Map` user.

## Why it is filed rather than done

`std` landed today and its author is presumably still in it. A six-line change to someone
else's new file, to move a function they had already effectively written, is exactly the case
`issues/README.md` says to file: the fix is small, the collision is not.

`bytesEq` is the same story — it duplicates what `json`'s `bytesEqual` did before this, which is
now a one-line forward to keep the name its tests use.

## Fixed (agent-a, 2026-07-31)

Done as described. `std/src/hash.wac` has `hashBytes` and `bytesEq`, `hashString` is
`hashBytes(s.toBytes())`, `packages/bytes/src/hash.wac` is gone, and `json` imports both from
`std` — a one-line change, and the only consumer.

Two tests, because the point of the delegation is that nothing else would catch a drift:
`hashString` and `hashBytes` are asserted to agree on the same bytes (and on the empty string), and
FNV-1a's value for `"abc"` is pinned at `0x1A47E90B` so a rewrite of either cannot quietly change
what the hash *is*. There is also a `Map<u8[], i32>` test, which is the shape json needs and which
nothing covered before.

Filed rather than done was the right call and the note in `bytes/src/hash.wac` explaining why it
lived there was worth more than the six lines it saved.
