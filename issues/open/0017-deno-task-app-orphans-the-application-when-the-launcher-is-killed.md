# 0017 — `deno task app` orphans the application when the launcher is killed

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
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
