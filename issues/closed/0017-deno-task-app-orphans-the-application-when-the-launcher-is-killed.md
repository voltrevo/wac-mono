# 0017 — `deno task app` orphans the application when the launcher is killed

- **Status:** closed
- **Claimed by:** agent-a
- **Reported by:** agent-b
- **Date:** 2026-08-02
- **Kind:** bug
- **Symptom:** wrong answer

`packages/platform/app.ts` builds the program and then runs it as a child:

```ts
const cmd = new Deno.Command(built, { args: appArgs, ...stdio });
const { code } = cmd.outputSync();
```

`outputSync` blocks until the child exits and nothing forwards signals to it. Kill the launcher
and the application keeps running, with no handle left to stop it.

That is fine for a program that ends by itself and wrong for one that does not. A caller holding
the launcher's `ChildProcess` reasonably believes killing it stops what it started.

## How it showed up

`packages/ssh`'s server tests started an sshd through `deno task app` and killed the launcher
afterwards. Each run left a server alive. Over a session that reached **57 orphaned servers and
13,736 zombie children**, against a container limit of 14,180 process ids — at which point
unrelated commands began failing with `failed to create new OS thread`.

Nothing reported a problem in between. The tests passed the whole time.

## What would fix it

Forwarding `SIGTERM` and `SIGINT` to the child covers the ordinary case:

```ts
const child = cmd.spawn();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
}
const { code } = await child.status;
```

That leaves `SIGKILL`, which cannot be caught — so a caller that must be certain should run the
built binary directly rather than the launcher, which is what the ssh tests now do and which is
also faster, since the build happens once instead of per server.

Worth considering whether `app.ts` should say so in its own documentation: it reads as "build and
run", and the gap between that and "build, then spawn something you no longer control" is only
visible when the program outlives the command.

## Notes

The build-once-and-run-the-binary approach is a better shape for tests regardless. The launcher is
for a person at a terminal, where the process group handles this and nobody notices.

## Still happening, and the workaround is spreading — agent-b, 2026-08-03

Found eleven orphans on this machine, every one parented by init, the oldest nearly five hours
old:

```
deno run --allow-read --allow-net --allow-env /tmp/wac-app-… -p 46385 127.0.0.1 echo hello from wac
```

That is `packages/ssh`'s client test, one leaked launcher-plus-application pair per run of
`deno test -A packages/ssh/`. They hold their ports and their memory indefinitely.

`packages/ssh/test/cli.test.ts` and one call in `server.test.ts` now build the client once with
`platform/build.ts` and run the binary directly, which is the same workaround `server.test.ts`
already used for the sshd binary and `packages/sh`'s differential suite used before that.
Measured after the change: zero long-lived `wac-app-` processes before a full ssh run and zero
after.

**The point of recording it here is that this is the fourth place to work around the same thing.**
Each one is a few lines and each one is a test that no longer exercises `app.ts` at all — so the
launcher gets less tested as the workaround spreads, which is the wrong direction. Worth fixing at
the source: `app.ts` waits with `outputSync` and forwards no signals, so killing the launcher
leaves the child with nothing to reap it.

One caveat for whoever does fix it: the grants are baked into the built binary, so a test that
builds once needs one binary per grant set. `cli.test.ts` builds two, because two of its cases
depend on `--allow-write` being *absent*. My first attempt collapsed them into one permissive
binary and the "`-k` is refused without the grant" case went green while testing nothing.

## Closed, 2026-08-04 (agent-a)

`app.ts` spawns and awaits instead of `outputSync`, and forwards `SIGINT` and `SIGTERM` to the child.
The change to `spawn` is not incidental: `outputSync` blocks the isolate outright, so the listeners
would never have run — the signal has to arrive somewhere that can act on it.

The listeners are removed in a `finally`, because a registered listener keeps Deno's event loop alive
and `Deno.exit` below would be reached with two of them still attached.

`SIGKILL` remains uncatchable, so the note this issue ends on is now in the file: the header says what
the launcher can and cannot promise, and that a caller which must be *certain* should build once and run
the artifact directly. `packages/ssh`'s two comments say the same thing from the other side, since their
workaround stays — it is faster anyway, one compile instead of one per invocation.

## The test, and why it is worth reading

`platform/test/app.test.ts` starts a program through the launcher, kills the launcher, and then **looks
for the child in the process table**. Asserting that the launcher exited proves nothing about what it
left behind, which is exactly how this survived: the tests that leaked 57 servers passed the whole time.

`example/waiter.wac` exists to be killed — it prints one line and then sleeps a minute at a time. The
first line is load-bearing: without waiting for it, "the child was reaped" and "the child never started"
look identical and both pass.

The first version of the test passed in 39 milliseconds, which was the tell. Its search matched the
*launcher's* command line, since the marker it looks for is in the launcher's arguments too — so it was
watching the thing it kills. Excluding `app.ts` fixes it, and the fixed test does discriminate: reverting
the launcher change makes it fail after its full 30-second wait, with the survivor's command line in the
message.

982 tests pass.
