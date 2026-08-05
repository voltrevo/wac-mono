/* Feed a router descriptor to tor's own parser and report what it makes of it.
 *
 * This is the oracle for generating descriptors, and it is the one that matters: design 0002's D1
 * says every component is validated by putting it where a real tor is on the other side of the seam.
 * A descriptor we generate and then parse ourselves would only establish that our writer and our
 * reader agree. `router_parse_entry_from_string` is the function a real relay's descriptor has to
 * satisfy, signatures and certificates included, and it needs no network to ask.
 *
 * Reads the document on stdin. With no argument it is a router descriptor; `cert` makes it an
 * authority key certificate, judged by `authority_cert_parse_from_string`.
 *
 * Reads the document on stdin. Exit 0 and `ACCEPTED` plus a few parsed fields, or exit 1 and
 * `REJECTED`. Build it the way capture-prop228.py builds its probe — against a configured and built
 * tor tree's libtor.a.
 *
 * Note the parser takes annotations separately: tor's cache format writes `@uploaded-at` and
 * `@source` *before* a descriptor, and `allow_annotations` is 0 here because a descriptor a relay
 * publishes has none. Feeding it text with annotations attached is rejected, which is how the
 * off-by-one-descriptor bug in capture-routerdesc.py was found.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "orconfig.h"
#include "core/or/or.h"
#include "feature/dirparse/routerparse.h"
#include "feature/nodelist/routerinfo_st.h"
#include "feature/dirparse/authcert_parse.h"
#include "feature/nodelist/authority_cert_st.h"
#include "lib/crypt_ops/crypto_init.h"
#include "lib/log/log.h"

int main(int argc, char **argv) {
  init_logging(1);
  if (crypto_early_init() < 0) { fprintf(stderr, "crypto_early_init failed\n"); return 2; }

  size_t cap = 1 << 20, len = 0;
  char *buf = malloc(cap);
  len = fread(buf, 1, cap - 1, stdin);
  buf[len] = 0;

  if (argc > 1 && !strcmp(argv[1], "cert")) {
    authority_cert_t *cert = authority_cert_parse_from_string(buf, len, NULL);
    if (!cert) { printf("REJECTED\n"); return 1; }
    printf("ACCEPTED\n");
    char fp[HEX_DIGEST_LEN + 1];
    base16_encode(fp, sizeof(fp), cert->cache_info.identity_digest, DIGEST_LEN);
    printf("fingerprint %s\n", fp);
    printf("dir_key_published %ld\n", (long)cert->cache_info.published_on);
    printf("expires %ld\n", (long)cert->expires);
    return 0;
  }

  routerinfo_t *ri = router_parse_entry_from_string(buf, NULL, 1, 0, NULL, NULL);
  if (!ri) { printf("REJECTED\n"); return 1; }
  printf("ACCEPTED\n");
  printf("nickname %s\n", ri->nickname ? ri->nickname : "(none)");
  printf("or_port %d\n", ri->ipv4_orport);
  printf("bandwidth %u %u %u\n", (unsigned)ri->bandwidthrate,
         (unsigned)ri->bandwidthburst, (unsigned)ri->bandwidthcapacity);
  return 0;
}
