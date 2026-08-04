# 0025 — `listen` takes no address, so every server binds every interface

- **Status:** closed
- **Claimed by:** agent-a
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

## Closed, 2026-08-04 (agent-a)

`listen` takes the address as its first argument, on all three hosts, and it is not optional. Both
things this issue asked for are in:

- **the bind.** `"127.0.0.1"` is loopback, `""` is every interface — the old behaviour, spelled out
  rather than defaulted into. The note above asks whether the default should be loopback; there is no
  default now, which answers it better: the surprising configuration is something a caller typed.
- **the peer.** `Socket` carries `peer`, filled by `accept` and empty for a socket this program
  dialled, plus `Socket.fromLoopback()` — the check that makes a wide bind survivable, and which was
  not expressible because the address existed on the host side and was dropped at the boundary.

Every caller now says what it means, which is the part worth reading:

| | binds | why |
|---|---|---|
| `packages/tor`'s SOCKS proxy | `127.0.0.1` | the issue's whole argument; it warned on every start about a configuration it could not choose |
| `packages/ssh`'s sshd | every interface | a daemon nobody can reach is not a daemon |
| `box httpd`, `box serve`, `box nc -l` | every interface | they exist to hand something to another machine |
| `platform/example/inetd.wac` | `127.0.0.1` | an example that runs a program for whoever connects should not be reachable while somebody reads it |

Four tests in `platform/test/listen.test.ts`, against the handler table because the boundary is what is
in question, with the connections made by Deno itself — a wac client would prove the same thing twice.
A loopback listener is reachable from `127.0.0.1` and *not* from this machine's own address; an empty
address is reachable from both; `accept` reports `127.0.0.1`; a dialled socket reports nothing. The
interface half needs `--allow-sys`, which the shared suite withholds, so it asks the permission and
stands down rather than throwing — the loopback halves still run either way.

Node's shim needed the same two changes: `server.listen({ host, port })`, and `remoteAddress` with
Node's IPv4-mapped `::ffff:` prefix unwrapped, which is the same address said longer.

981 tests pass.
