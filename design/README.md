# design

One numbered document per **direction**: something we are aiming at that is too big to be an issue and
too load-bearing to live in a commit message.

`issues/README.md` says an issue is "something actionable that is not already written down", and lists
three other homes — a package's README for its own roadmap, `~/notes/living/` for costs measured across
projects, and `wac/issues/` for compiler bugs. A direction is a fourth kind: it spans packages, it takes
more than a sitting, and the decisions in it constrain code that has not been written yet.

## What belongs here

- **The target**, concretely enough to tell whether we have arrived, and what it explicitly is *not*.
- **The decisions already taken**, each with the reason. A decision without its reason is a rule nobody
  can revisit, which is how a design becomes scar tissue.
- **The order of work**, with what "done" looks like for each step.
- **A state of play**, one line per step, updated as pieces land. This is the part that keeps the
  document honest: a design that says "next: a process table" six weeks after the process table landed
  is worse than no document.

## What does not belong here

- Anything actionable now — that is an issue, and the issue **references this document rather than
  restating it**. Two records of one plan drift, which is the argument `issues/README.md` already makes
  about the GitHub mirror.
- A package's own roadmap. Once a direction has produced a package, its limitations and next steps go in
  its README, and this document links to it.
- Progress narration. The state of play is a table, not a diary; what happened and why lives in the
  commit that did it.

## Writing one

`design/NNNN-short-slug.md`, taking the next free number. Same numbering habit as issues, and the same
rule for a collision: renumber yours, it is a rename, and the loser is whoever pushes second.

Add a line to the table below in the same commit — the index is the thing people read.

A document is not a promise. Retiring one is ordinary: set its status to `abandoned` with the reason,
which is worth more to the next reader than deleting it.

## The documents

| # | direction | status |
|---|---|---|
| [0001](0001-a-self-contained-system.md) | a self-contained system: a filesystem, processes and users in wac, with the ssh and browser demos as its terminals | active |
| [0002](0002-the-whole-tor-stack.md) | the whole Tor stack: relays, authorities and onion services, and a network of our own | active |
