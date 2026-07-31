# std

Containers and the two sum types every program ends up wanting.

```wac
import { Vec } from "../../std/src/vec.wac";
import { Map } from "../../std/src/map.wac";
import { Option } from "../../std/src/option.wac";
import { Result } from "../../std/src/result.wac";
import { hashString, stringEq } from "../../std/src/hash.wac";
```

| type | what |
|---|---|
| `Vec<T>` | growable array; `push`/`pop`/`get`/`insert`/`remove`, amortised O(1) append |
| `Map<K, V>` | hash map, open-addressed with linear probing; hash and equality as funcrefs |
| `Option<T>` | a value or nothing, taken apart with `match` |
| `Result<T, E>` | a value or an error, with the error type up to the caller |
| `hash.wac` | ready-made hash and equality for `string`, `i32` and `i64` |

This package exists because wac gained generics ([wac issue
0034](../../../wac/issues/closed/0034-generics.md)). Before that a container could only be
written once per element type, which is why this repo had three hand-rolled ones.

## Vec

```wac
Vec<i32> v = Vec.create();
v.push(10);
v.push(20);
i32 first = v.get(0);              // traps if out of range
i32 safe = v.at(5).orElse(-1);     // None instead of a trap
Option<i32> last = v.pop();
```

`create()` allocates nothing; the first push allocates four slots and capacity doubles from
there. `withCapacity(n, fill)` presizes.

**Why `withCapacity` wants a `fill` value.** WasmGC arrays are initialised when they are
created, and wac will not invent a value for a `T` it knows nothing about — a struct or an
enum has no default. `push` never needs one because the element being pushed is available at
exactly the moment growth happens; `withCapacity` has no such value to hand, so it asks. The
slots above `len()` are unreachable through the API, so what you pass is never read.

**`clear()` and `pop()` do not release elements.** There is nothing to overwrite a slot
with, so a popped or cleared element stays reachable from the backing array until something
is pushed over it. It matters only for a long-lived Vec of large elements.

## Map

```wac
Map<string, i32> counts = Map.create(hashString, stringEq);
counts.set("apple", 1);
bool existed = counts.set("apple", 2);      // true — it overwrote
Option<i32> got = counts.get("apple");
i32 orZero = counts.getOr("pear", 0);
counts.remove("apple");
```

**Hash and equality are funcrefs, not a requirement on `K`.** wac has no traits, so there is
no `K: Hash` to ask for. This turns out better than a trait would have been: `hash.wac` has
the ready-made ones, and hashing case-insensitively, or on one field of a struct, needs no
wrapper type — just a different pair of functions.

```wac
i32 hashPoint(Point p) { return hashI32(p.x * 31 + p.y); }
bool pointEq(Point a, Point b) { return a.x == b.x && a.y == b.y; }
Map<Point, string> labels = Map.create(hashPoint, pointEq);
```

A hash may return any `i32`; the table masks it. A poor distribution costs collisions rather
than correctness — `test_collisions` runs a table where every key hashes to zero.

`hashBytes`/`bytesEq` are the `u8[]` pair, and `hashString` delegates to `hashBytes` rather than
repeating FNV-1a. Not tidiness: two copies of a hash can drift into disagreeing about the same
bytes, and nothing would catch it — a Map answers every query correctly as long as *one* hash is
used per map, so it would surface only where something hashed a key one way and looked it up the
other. `json` holds member names as bytes on purpose, so it needs the byte-level pair; the test
asserts the two agree (wac-mono issue 0004, reported by agent-b).

**Linear probing with backward-shift deletion**, not chaining and not tombstones. One array
rather than one per bucket, and a table that is filled and emptied repeatedly does not
degrade — `test_fill_and_empty_repeatedly` asserts that 400 insert/remove pairs leave the
table no larger than 32 slots.

`keys()` and `values()` are in slot order, which is to say **an order you must not rely on**:
it depends on the hash, the capacity and the insertion history. They correspond to each
other index by index.

## Option and Result

```wac
Option<i32> found = m.get(k);
match (found) {
  case Some(v): return v;
  case None:    return 0;
}
```

`T?` works for every type, primitives included ([wac issue
0045](../../../wac/issues/closed/0045-nullable-primitives-are-not-boxed.md)), and for a
*reference* it is cheaper — one word, no allocation. So `Point?` is the right thing to write and
`Option<Point>` is not.

`Option` earns its place on two narrower grounds. **A nested absence:** `T??` does not exist, so
a container of nullables cannot distinguish "no entry" from "an entry holding null" — which is
why `Map.get` returns an Option rather than a `V?`, since `Map<string, JsonValue?>` is a real
shape. **An absent case that is a compile error to forget:** `match` is exhaustive, and a
missing null check is not.

A nullable primitive is boxed and so is an Option, so between `i32?` and `Option<i32>` there is
nothing to choose on cost. Pick by which of those two reasons applies.

`mapOption(o, f)` is a free function rather than a method because a method cannot introduce a
type parameter of its own — `U` is not the enum's:

```wac
Option<string> described = mapOption(count, describe);   // T from the Option, U from describe
```

`Result<T, E>` leaves the error type to the caller, because the useful error differs: a
parser wants a message and a position, an arithmetic routine wants a code, and a caller that
only branches wants `Result<T, bool>`.

## What is not here yet

- **`Set<T>`.** `Map<T, bool>` is the whole implementation, and a wrapper is worth writing
  when something wants one.
- **Iteration without copying.** `keys()` and `values()` allocate. wac has no iterator
  protocol and no closures, so the shape a lazy iterator would take is not obvious yet;
  index-based loops over `keys()` are what this repo does.
- **`sort`.** A generic sort over a `fn[bool(T, T)]` comparator belongs here. `gzip` and
  `bignum` both sort by hand today.
- **A string builder.** `bytes`' `Buf` is the byte-level answer; repeated `s + t` is
  quadratic and nothing here fixes that.

## Testing

`test/wac/*_test.wac` are unit tests written in wac. `test/traps.test.ts` is host-side
because a trap aborts the module, so no wac test can assert one — which is where the bounds
checks are covered, including the case a wac test cannot reach: an index inside the
allocation but past the length.

`map_test.wac` ends with a **differential test**: the same pseudo-random operation sequence
run against `Map` and against a naive association list of two parallel `Vec`s, compared after
every operation. Six deliberate mutations of `Map` were tried against these tests and all six
were caught, five of them by the differential run — a probe-sequence bug needs a specific
interleaving of insertions, overwrites and removals that no hand-written case is going to hit.
