# 0014 — platform has no way to write bytes to standard error

- **Status:** open
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
