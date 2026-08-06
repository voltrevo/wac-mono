/* Feed a microdescriptor to tor's own parser and report what it makes of it — including the digest.
 *
 * The oracle for `src/microdesc.wac`. Two things need pinning and only tor can pin either:
 *
 *   1. **Is the document well-formed?** `microdescs_parse_from_string` is the function a client's
 *      microdescriptor has to satisfy, and `dirvote_create_microdescriptor` itself ends by feeding its
 *      own output back through this parser and warning "We generated a microdescriptor we couldn't
 *      parse" if it fails — so parsing is the standard tor holds its own generator to.
 *
 *   2. **What digest does it get?** A consensus's `m` line names a microdescriptor by the base64 of
 *      SHA-256 over its body, and a client that computes a different digest discards every
 *      microdescriptor it fetches while reporting only that it has no usable relays. That failure is
 *      silent in exactly the way this probe is here to prevent: the document parses, the consensus
 *      parses, and nothing joins them up.
 *
 * The digest is not a claim about our SHA-256 — that has its own vectors. It is a claim about the
 * *span*: which bytes of the document are hashed. Every digest bug in this package so far has been a
 * span bug (see `routerdesc.wac` on the three different terminators), so this is the part worth
 * asking tor about.
 *
 * Reads one microdescriptor on stdin. Exit 0 and `ACCEPTED` plus the digest and the fields tor
 * recovered, or exit 1 and `REJECTED`. Build it the way capture-prop228.py builds its probe — against
 * a configured and built tor tree's libtor.a.
 *
 * Note `allow_annotations` is 0: a cache writes `@last-listed` before a stored microdescriptor, and a
 * microdescriptor as an authority generates it has none.
 */
#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include "orconfig.h"
#include "core/or/or.h"
#include "feature/dirparse/microdesc_parse.h"
#include "feature/nodelist/microdesc.h"
#include "feature/nodelist/microdesc_st.h"
#include "feature/nodelist/torcert.h"
#include "lib/crypt_ops/crypto_init.h"
#include "lib/crypt_ops/crypto_format.h"
#include "lib/encoding/binascii.h"
#include "lib/log/log.h"
#include "app/config/config.h"
#include "app/main/subsysmgr.h"

int
main(void)
{
  /* The same initialisation `parsedesc-probe.c` explains at length, cut to what this parser needs:
   * without a log destination an assertion inside tor aborts with a raw backtrace and no reason, which
   * is a slow way to discover that a parser wanted more setup than it was given. */
  subsystems_init();
  init_logging(1);
  {
    log_severity_list_t sev;
    set_log_severity_config(LOG_WARN, LOG_ERR, &sev);
    add_stream_log(&sev, "stderr", STDERR_FILENO);
  }
  if (crypto_global_init(0, NULL, NULL) < 0) {
    fprintf(stderr, "crypto_global_init failed\n");
    return 2;
  }

  size_t cap = 1 << 16, len = 0;
  char *buf = tor_malloc(cap);
  size_t n;
  while ((n = fread(buf + len, 1, cap - len - 1, stdin)) > 0) {
    len += n;
    if (len + 1 >= cap) { cap *= 2; buf = tor_realloc(buf, cap); }
  }
  buf[len] = '\0';

  smartlist_t *invalid = smartlist_new();
  smartlist_t *mds = microdescs_parse_from_string(buf, buf + len, 0, SAVED_NOWHERE, invalid);

  if (!mds || smartlist_len(mds) != 1) {
    printf("REJECTED\nreason: parsed %d microdescriptors, wanted 1\n",
           mds ? smartlist_len(mds) : 0);
    printf("invalid_digests: %d\n", smartlist_len(invalid));
    return 1;
  }

  microdesc_t *md = smartlist_get(mds, 0);

  char d64[BASE64_DIGEST256_LEN + 1];
  digest256_to_base64(d64, md->digest);

  printf("ACCEPTED\n");
  printf("digest256_base64: %s\n", d64);
  printf("bodylen: %d\n", (int)md->bodylen);

  if (md->onion_curve25519_pkey) {
    char kbuf[CURVE25519_BASE64_PADDED_LEN + 1];
    curve25519_public_to_base64(kbuf, md->onion_curve25519_pkey, false);
    printf("ntor_onion_key: %s\n", kbuf);
  } else {
    printf("ntor_onion_key: (none)\n");
  }

  if (md->ed25519_identity_pkey) {
    char idbuf[ED25519_BASE64_LEN + 1];
    ed25519_public_to_base64(idbuf, md->ed25519_identity_pkey);
    printf("ed25519_id: %s\n", idbuf);
  } else {
    printf("ed25519_id: (none)\n");
  }

  printf("has_onion_pkey: %d\n", md->onion_pkey ? 1 : 0);
  printf("exit_policy: %s\n", md->exit_policy ? "present" : "(none)");

  return 0;
}
