# server

An HTTP server written in wac. It runs, and you can curl it.

```sh
deno task serve 8080
curl -i http://127.0.0.1:8080/
curl -X POST -d '{"b":1,"a":[1,2]}' http://127.0.0.1:8080/json
```

## Why it exists

Everything else in this repo transforms bytes and gets compared against an oracle. Nothing ran.
This is the first thing that composes the packages rather than sitting beside them, and that is
the point: **integration is where this repo's bugs have actually been.** Every time something
became the first outside consumer of something else — `json` of `std`, `url` of `bytes`, the
fuzzer of its own oracle — it found a defect the unit tests had missed.

It found one immediately. `packages/json` exports `canonicalize`, which is its *bindgen* entry
point: byte 0 is a status code, because an export returns one value. Calling it as a library from
wac put a NUL at the front of every JSON response and made a parse failure indistinguishable from
success — both are a `u8[]`, so nothing caught it. The fix is to call `parse.wac` and
`stringify.wac`, which is what a wac caller should have been using; `json.wac` is the boundary
module, not the library. Nothing in the type system says so.

## Shape: the server is a pure function

wasm has no sockets and no clock, so the host owns both and hands the results in. Everything else
is in wac:

```wac
Served serve(u8[] input, i64 nowMillis)
// → ready?  the response bytes  how many input bytes it used  keep the connection?
```

`host/serve.ts` is the whole of the host side — an accept loop, a buffer, and `writeAll`. It makes
no decisions. That split is why the server is testable by *calling* it: `test/serve.test.ts` drives
every case including pipelining and truncation with no socket in sight, and `test/live.test.ts`
then checks the answers survive real clients.

`consumed` is what makes keep-alive work, and the host keeping the remainder rather than clearing
the buffer is what makes pipelining work — a client may have sent the next request already and it
is sitting in the tail.

## Routes, chosen to make the packages meet

| route | what it puts on the request path |
|---|---|
| `GET /` | the response writer alone |
| `GET /time` | `datetime` — the host's instant, as RFC 3339 |
| `GET /echo?a=1&b=hello+world` | `url` — percent-decoding and the query |
| `POST /json` | `json` — parse the body, give it back |
| `GET /b64/<data>` | `codec` + `url` — percent-decode, then base64url |
| `GET /match/<pattern>/<subject>` | `regex` — compile, run, report the captures |

`POST /json` returning `{"b":1,"a":[1,2],"n":1e2}` byte for byte is `packages/json` keeping the
source span: a re-formatter would have written `100`.

## Tests

**`test/serve.test.ts`** — the function. Routes, error statuses, HEAD, `Allow` on a 405, the
keep-alive rules for 1.0 and 1.1, every prefix of a request being answered as "not yet", framing
refusals closing the connection, and that the server's own responses are well-formed: exactly one
`Content-Length`, no `Transfer-Encoding`, and a length that matches the bytes.

**`test/live.test.ts`** — the server, behind a socket, driven by three clients:

- **`fetch`**, which is strict and rejects a malformed response outright;
- **Node's `http.request`**, a second independent implementation — a response both accept is a
  response, not merely something self-consistent;
- **a raw socket**, for what no client will do on purpose: two requests pipelined in one packet,
  a request delivered one byte at a time, a smuggling-shaped message, and a client that vanishes
  mid-request.

The socket cases are why the file exists. Keep-alive and pipelining are properties of a
*connection*, and no amount of testing a function from bytes to bytes can demonstrate them.

`deno task coverage:server` reports 92%.

## Limits

In the host, because they are about time and connections and wac can see neither:

| limit | default | what it stops |
|---|---|---|
| `requestMs` | 10 s | a client that starts a request and stalls partway through |
| `idleMs` | 30 s | a kept-alive connection that goes quiet and never comes back |
| `maxConnections` | 256 | unbounded concurrency; further connections are closed at once |

A stalled request gets a `408` and a close, because there is a request to answer. An idle
connection is dropped without one, because there is not. Both are tested against a server started
with 120 ms budgets.

## Not here yet

- **Responses are always `Content-Length`.** The body is always assembled before the headers are
  written, so chunked output is never needed. A streaming handler would need it.
- **`gzip` is not wired in**, though the package exists — `Accept-Encoding` and a compressed body
  is the obvious next route, and would make seven packages meet instead of six.
- **No TLS**, which needs `crypto` and is a different project.
