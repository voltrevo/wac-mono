# 0014 — platform has no way to write bytes to standard error

- **Status:** closed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b
- **Date:** 2026-08-02
- **Kind:** missing feature
- **Symptom:** not implemented

`Cli` has `write` for standard output as bytes and `Core` has `warn` for the error channel as a
*string, one line at a time*. There is no `writeErr`, so an application cannot put arbitrary bytes
on standard error, and cannot interleave the two streams in the order it produced them.

## Where it bites

`packages/ssh` runs a remote command and has to reproduce its output. The server sends stdout and
stderr interleaved, tagged, in the order the command wrote them. The client can reproduce stdout
exactly and cannot reproduce stderr at all:

- stderr is buffered to the end of the run and emitted as one `warn`, because emitting per chunk
  would insert a newline at every packet boundary;
- so the ordering between the two streams is lost, and a command whose stderr is not valid UTF-8
  comes out mangled.

Both are visible to anyone comparing `wacssh host cmd` with `ssh host cmd`.

## What would fix it

`fn[bool(u8[])] writeErr` next to `write`, with the same shape and the same absence of a grant —
what a program prints is the user's own doing, which is the argument `write` already makes.

That leaves `warn` alone: it is the right thing for a diagnostic line and every applet in
`packages/box` uses it that way. The two are not redundant, they are different jobs — `warn` is
the program talking about itself, `writeErr` is the program passing bytes through.

## Notes

Not filed against `box`: no applet needs it today, because none of them is a conduit for another
program's output. `ssh` is the first, and `nc` would be the second.

The same argument applies to reading: `readStdin` reads to the end, so a program cannot stream its
own input while producing output. `ssh` does not need it — a remote command's input is a separate
problem it does not solve yet — but anything interactive would, and the two are one design
question rather than two.

## Closed, 2026-08-04 (agent-a)

`fn[bool(u8[])] writeErr` beside `write`, no grant, opcode 48 — the shape this issue asked for, and
`warn` is untouched for the reason given above: the two are different jobs, and every applet in
`packages/box` wants the line.

The three hosts write it to their own error stream and deliberately *not* through `openOutput`'s sink:
a redirection that took the error stream with it would leave a program no way to separate them, which
is the whole point of having two. A child running inside its parent (`pushChild`) has it kept with the
rest of its captured error output; a spawned worker sends it down the one stream its parent reads,
in the order it was written.

Two callers changed, and both were named here:

- `packages/ssh` puts each `SSH_MSG_CHANNEL_EXTENDED_DATA` packet straight out as it arrives, so the
  two streams interleave exactly as the remote command wrote them.
- `packages/sh` grew `Shell.err`, the one place that decides where a diagnostic goes: a capturing
  shell keeps the bytes for whoever asked for the capture, and a shell attached to a terminal writes
  them out immediately. `echo one; nope; echo two` now puts the complaint between the two lines, which
  a new test in `test/differential.test.ts` compares against bash by *position* — the wording differs
  between the two shells, the ordering must not.

`outputError` answers for both streams rather than gaining a twin. No caller has needed to know which
stream failed: the question is asked to decide between exiting 0 and reporting a real failure, and
that decision is the same either way. If one ever does, splitting it will be a visible change rather
than a guess.

The reading half of the note above is still open and still one design question: `readStdin` reads to
the end, so a program cannot stream its own input while producing output. Nothing needs it yet.
