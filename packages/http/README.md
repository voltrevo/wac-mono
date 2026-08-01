# http

An HTTP/1.1 request parser.

```wac
import { Parsed, Request, parseRequest } from "../../http/src/request.wac";

match (parseRequest(buffer, 1 << 20)) {
  case Ok(request): { /* request.method, .target, .headers, .body, .consumed */ }
  case Incomplete:  { /* read more bytes and call again */ }
  case Bad(code):   { /* refuse the connection */ }
}
```

## Three outcomes, not two

A message can be complete, refused, or **not yet decided**, and keeping the third apart from the
other two is the whole design. A parser that folds "I need more bytes" into "no" drops connections
on any client that writes in more than one packet. One that folds it into "yes" reads a truncated
message as a whole one.

So `Parsed` has three cases and every caller has to say what it does about each. Two of the test
suites exist only for this: they feed in *every prefix* of a valid request and of a valid chunked
request, and require that none of them is reported as malformed.

## What it refuses, and why that is the point

Request smuggling is not a parser bug — it is two parsers *disagreeing*. When a front-end and a
back-end read the same bytes as different messages, an attacker who can reach both writes one
request that the front sees as one message and the back sees as two. The defence is not
cleverness, it is refusing every input whose framing is ambiguous. From RFC 9112 §6:

| refused | because |
|---|---|
| `Content-Length` and `Transfer-Encoding` together | one reads a byte count, the other reads chunks |
| `Content-Length` twice, even with equal values | some parsers take the first, some the last, some reject |
| a `Content-Length` that is not plain decimal — `+5`, `0x5`, `5 `, `5,5` | read as 5 by some and refused by others |
| a `Transfer-Encoding` whose last coding is not `chunked` | there is then no defined body length |
| obsolete line folding (`X: 1\r\n 2`) | a value that can contain CRLF can contain a header |
| whitespace around the colon (`Host : a`) | the name is `Host` to one parser and `Host ` to another |
| a control byte or a byte above 0x7F in a value | no defined encoding, so two hops decode it differently |

Each has a test naming the shape it prevents, and `consumed` is checked separately — a parser
right about the body but wrong about where it *ended* desynchronises a pipelined connection just
as thoroughly.

## The oracle is llhttp, driven as a server

`test/oracle_node.mjs` starts a Node server on loopback, feeds each case in on its own connection,
and reports what came out: parsed, refused, or still waiting. Node parses with llhttp, so this is
a real parser with years of adversarial attention rather than a reference reimplementation.

The comparison is asymmetric on purpose. For a well-formed message, every field is compared —
method, target, version, each header in order with duplicates, body. For a malformed one, only
**acceptance** is compared, not the reason: which error a parser reports is unspecified and the
two will not agree, but *whether* it accepts is exactly the property whose disagreement is a
vulnerability.

Four known differences are skipped and counted rather than hidden, each with a rule:

- **Node needs `Host` to dispatch** an HTTP/1.1 request, so the oracle says "incomplete" for one
  without it whatever its parser thought. An artifact of driving a server rather than a parser.
- **llhttp accepts HTTP/0.9.** This refuses it: a 0.9 request has no headers and no way to frame a
  body, so treating one as 1.x is how a request line becomes a body.
- **llhttp accepts `HTTP/2.0` in a request line.** RFC 9112 §2.3 allows answering 505; parsing it
  as 1.x and proceeding is not among the options.
- **llhttp has a closed method table.** RFC 9110 §9 says a method is any token and an unknown one
  is a 501 — a semantic answer, not a parse failure. So this is deliberately more permissive, and
  it is safe to be: an unrecognised method cannot change where a message ends.

The fuzzer applies one to three mutations to valid messages — insert, delete, replace, truncate,
splice in a framing header, duplicate a line — and asserts the acceptance property over 500 cases.
It also counts how many it compared and how many the oracle accepted, because a corpus of
rejections agrees trivially and would pass while testing nothing.

**The fuzzer found a bug in the oracle**, which is worth recording: results were correlated by a
running index, so a `clientError` arriving after the next connection opened was recorded against
the wrong case, and valid requests were reported as errors. Correlating by the client's port fixed
it. An oracle is a program and needs the same suspicion as the thing it judges.

`deno task coverage:http` reports 94%.

## Not here yet

- **Responses.** The status line and the response framing rules — which differ, notably in that a
  response may be delimited by connection close, and that HEAD and 204 have no body regardless of
  headers.
- **A streaming interface.** Everything takes a whole buffer and re-parses from the start.
  `consumed` makes pipelining work, but a large body is assembled in memory; a real server wants
  to hand chunks to the caller as they arrive.
- **`Host` validation and absolute-form reconciliation**, which is where `packages/url` should be
  wired in — the target is checked for shape here but not parsed.
- **Header field limits** — a count cap and a per-line length cap, which every real server has and
  which belong next to `maxBody`.
