# 0015 — platform cannot start a process, so a server cannot run a command

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b
- **Date:** 2026-08-02
- **Kind:** missing feature
- **Symptom:** not implemented

`Cli` has twenty-six capabilities and none of them starts a process. So an application can accept
a connection, authenticate it, and be asked to run `uname -a` — and has no way to run it.

Filed against this repo rather than the compiler: capabilities are `packages/platform`'s host and
its `Cli` struct, and nothing about it is a language feature.

## Where it bites

`packages/ssh` can now do everything an SSH *server* needs except the last step. The transport,
the key exchange, the cipher and the channel layer are direction-agnostic or already written; what
is missing is entirely outside SSH:

```
SSH_MSG_CHANNEL_REQUEST  "exec"  "uname -a"
                                  ^ and then what
```

The server can answer with a fixed set of commands implemented in wac, which is what it will do,
and that is a different thing from an sshd. It is worth being clear that this is the *only* reason
it is a different thing.

`packages/box` has the same hole from the other side: fifty-seven applets and no `xargs`, no
`find -exec`, no `sh`, because none of them can be written.

## What it would look like

```wac
/** Run a program to completion. Its output is captured, not inherited. */
fn[Exit(string, string[])] run;

export struct Exit {
  i32 code;
  u8[] stdout;
  u8[] stderr;
  string error;      // non-empty when the program could not be started at all
}
```

Capture rather than inherit, because a caller that wants the bytes — a server relaying them down a
channel — cannot get them from an inherited stream, while a caller that wants them on its own
output can write them there. The reverse is not true.

`Deno.Command` and `node:child_process` both provide exactly this synchronously, so it fits the
world's existing shape without any of the async machinery `recv` needed.

## Notes

**This is the capability most worth thinking about before adding**, because it is the one that
makes every other grant transitive: a program with `run` can start something that has permissions
it does not. `--allow-run` in Deno has the same property and is why it is not implied by anything
else. An allowlist of program names at build time — `--allow-run=git,ssh` — would keep the grant
as narrow as the others are, and matches what Deno already accepts.

Streaming is a separate question and probably a later one. A captured-output `run` cannot express
`tail -f`, and an SSH server relaying a long-running command wants the bytes as they appear rather
than at exit. That needs the same shape as `openInput`/`readChunk` — start, then read until done —
and is worth leaving until something needs it, since the capture form is what almost every caller
wants and is much harder to get wrong.
