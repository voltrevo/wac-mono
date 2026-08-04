// Opcodes, shared by both sides of the bridge.
//
// Numbers rather than names because they cross as an i32 in the control block, and a
// number nobody has to parse is one fewer thing to get wrong. Append only: a value that
// has shipped never changes meaning.

export const OP = {
  NOW_MILLIS: 1,
  MONOTONIC_NANOS: 2,
  RANDOM_BYTES: 3,
  LOG: 4,
  WARN: 5,
  ARG_COUNT: 6,
  ARG: 7,
  ENV: 8,
  READ_FILE: 9,
  WRITE_FILE: 10,
  READ_STDIN: 11,
  WRITE_STDOUT: 12,
  STAT: 13,
  READ_DIR: 14,
  MKDIR: 15,
  REMOVE: 16,
  RENAME: 17,
  OPEN_INPUT: 18,
  READ_CHUNK: 19,
  OPEN_OUTPUT: 20,
  CONNECT: 21,
  LISTEN: 22,
  ACCEPT: 23,
  RECV: 24,
  SEND: 25,
  CLOSE_SOCKET: 26,
  SPAWN: 27,
  EXIT_CODE: 28,
  CLOSE_FEED: 29,
  SLEEP_MILLIS: 30,
  RENDER: 31,
  SET_TEXT: 32,
  SET_VALUE: 33,
  GET_VALUE: 34,
  ON: 35,
  NEXT_EVENT: 36,
  TITLE: 37,
  DRAW_PIXELS: 38,
  NEXT_FILE: 39,
  OFFER_DOWNLOAD: 40,
  CWD: 41,
  PUSH_CHILD: 42,
  POP_CHILD: 43,
  OUTPUT_ERROR: 45,
  LINK_STAT: 47,
} as const;

/**
 * Grant flags for `OP.SPAWN`, matching the `GRANT_*` constants in `platform.wac`.
 *
 * Here rather than in a world because both sides of the bridge read them, and because a
 * fourth copy of these numbers — wac, worker, each host — is three too many already. The
 * host intersects a request with its own authority; see `deno.ts`.
 */
export const GRANT_READ = 1;
export const GRANT_WRITE = 2;
export const GRANT_NET = 4;
export const GRANT_ENV = 8;
