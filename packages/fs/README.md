# fs

A filesystem that belongs to the system rather than to the host.

```wac
Fs fs = Fs.inMemory(now);          // nothing but what you put in it
fs.mkdir("/home/user", true);
fs.writeFile("/home/user/notes", "hello\n".toBytes());

Fs disk = Fs.onHost(cli, now);     // the real one, by asking
```

A package of [wac-mono](../../README.md) — see the root README for layout and how to run things. All
commands run from the repo root.

## Why

[design/0001](../../design/0001-a-self-contained-system.md) step 1, filed as
[0067](../../issues/open/0067-no-filesystem-of-our-own-so-a-session-cannot-be-sealed-off-from-the-host.md).
Every filesystem capability a program has is the *host's*, so `packages/ssh`'s demo hands each session the
real disk of whatever ran the daemon, and the browser terminal hands it the tab's Origin Private File
System. There is nothing that belongs to the system: nothing to seal a session inside, nothing to persist
as an image, and nothing hermetic for a test to run against — which is where today's flakes come from,
since every filesystem test needs a temp directory on a disk shared with everything else on the machine.

## One type with a mount table, and why not an interface

The obvious design is an abstract filesystem with a memory implementation and a host implementation. wac
will not do it: `override` is a source-level check and **dispatch is static**, so a `Circle` held in a
`Shape` variable answers `Shape.name()`. A base-typed `Fs` would always run the base's bodies. The
language's own idiom for varying behaviour is a funcref plus explicit state — `Shell.external` is one —
and a funcref cannot capture a filesystem, because there are no closures.

So there is one concrete `Fs` holding a mount table, and the branch is written by hand. The tour says to
do exactly that, and it turned out to be the shape the design wanted anyway: a **host mount** is how
"translate to real operations on the host" survives as something a caller asks for rather than as what
happens when nobody says anything.

Mounts resolve by longest prefix, so `/home` mounted under a host `/` does what a person expects and the
order they were added in does not decide the answer. A mount *shadows* what it covers rather than merging
with it, and a name that merely starts with the mount point — `/homework` against `/home` — is not under
it.

## The host is the oracle

`example/ops.wac` runs a script of operations against either backing:

```
deno task app:build packages/fs/example/ops.wac --allow-read --allow-write -o ops
printf 'mkdir /d\nwrite /d/f hello\nls /d\n' | ./ops mem
printf 'mkdir /d\nwrite /d/f hello\nls /d\n' | ./ops host /tmp/somewhere
```

`test/host.test.ts` runs the same scripts both ways and compares the transcripts. Whatever Deno's
filesystem does to a sequence of writes, listings, renames and removals is what a filesystem *is*; a
memory implementation that disagrees is wrong even when its own tests pass. The two runs share nothing but
the script bytes.

It earned that on the first run, three times:

- **A directory's size.** The host says 4096 — its block size on this container's ext4, something else
  elsewhere. That is not a semantic worth imitating, so the transcript prints `stat dir` without a size
  rather than matching a number no program should read.
- **Reading a directory** answers `FAULT_OTHER`, not `FAULT_DENIED`. The category set has no "is a
  directory", so `host/faults.ts` classifies `EISDIR` as other and the message carries it. Matching the
  hosts was the right call for now; whether the taxonomy should grow a category is noted in 0067, because
  `cat` on a directory and `cat` on a missing file *are* different mistakes.
- **Writing over a directory** answers the same way, for the same reason.

`test/wac/fs_test.wac` covers what a differential cannot reach: the fault categories directly, the mount
table's longest-prefix rule, and that a name is **bytes** — a file called `x\xff\xfey` keeps all four,
which is a property no host can offer today
([0065](../../issues/open/0065-a-spawned-programs-arguments-are-not-byte-exact.md)).

## Not here yet

- **Nothing calls it.** `packages/sh` still reaches its `Cli` directly for file operations; threading `Fs`
  through the shell is the rest of 0067, and it is what makes a session's filesystem a choice.
- **No persistence.** `Fs.inMemory` and `Fs.onHost` exist; an image is step 2 of design/0001, and
  `packages/box` already has `tar` and `zstd` to write one with.
- **No permissions.** `mode` and `owner` are recorded on every node and enforced nowhere. Users arrive in
  step 4; recording them now is what makes an image written today readable then.
- **Removal does not free nodes.** A node nobody points at is unreachable, and an image writer walks from
  the roots, so nothing is lost — but a program that deletes a great deal keeps paying for it. There is
  no such program yet.
- **`rename` across mounts is refused**, in those words. Doing it means a copy and a delete, and a
  `Change` cannot report a partial one.
- **No symbolic links.** `linkStat` is `stat` and says so.
