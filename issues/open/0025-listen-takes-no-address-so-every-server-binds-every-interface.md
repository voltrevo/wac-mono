# 0025 — `listen` takes no address, so every server binds every interface

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-c
- **Date:** 2026-08-03
- **Kind:** missing feature
- **Symptom:** not implemented

`Cli.listen` is `fn[Pending<Socket>(i32)]` — a port and nothing else. The host does
`Deno.listen({ port })`, which binds `0.0.0.0`. A program cannot ask for loopback.

```wac
Socket listener = cli.listen(9050).wait();   // reachable from anywhere, unavoidably
```

Expected: an address argument, so `listen("127.0.0.1", 9050)` is expressible.
Actual: every server written on this platform is reachable from every interface.

## Why this matters more than the usual missing argument

For most servers this is a deployment inconvenience. For `packages/tor/src/socks.wac` it is
the difference between two different programs.

A SOCKS proxy on loopback serves the person at the keyboard. The same proxy on `0.0.0.0` is
an **open proxy**: anyone who can reach the host can push traffic through it, and it emerges
from a Tor exit that this circuit chose. The operator ends up sourcing strangers' traffic
without having agreed to, and the strangers get an anonymity property they did not build.

Loopback is also the default every other SOCKS implementation ships with, for this reason —
tor's own `SocksPort 9050` means `127.0.0.1:9050`. So the safe configuration is not merely
unavailable here, it is the one people will assume they already have.

The proxy warns on every start rather than working around it, because there is no way to
work around it: the bind happens in the host and nothing in the capability world reaches it.

## A second, smaller thing in the same place

`accept` answers with a `Socket`, which is `{handle, error}` and carries no peer address. A
server therefore cannot log who connected, rate-limit by source, or refuse non-loopback
peers — which is the check that would have made this issue survivable in the meantime.

Both are the same shape: the address exists on the host side and is dropped at the boundary.

## Notes

`Deno.listen` takes `{ hostname, port }`, so the host change is one field. The wac side is a
second parameter on one `fn[]` type in `Cli`, its constructor, and the host's `OP.LISTEN`
reading a string beside the i32.

Worth deciding whether the default with no address should be loopback rather than
`0.0.0.0`. Binding the world is the more surprising of the two defaults, and a program that
wants it can say so.
