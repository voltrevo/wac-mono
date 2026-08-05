/* Feed a router descriptor to tor's own parser and report what it makes of it.
 *
 * This is the oracle for generating descriptors, and it is the one that matters: design 0002's D1
 * says every component is validated by putting it where a real tor is on the other side of the seam.
 * A descriptor we generate and then parse ourselves would only establish that our writer and our
 * reader agree. `router_parse_entry_from_string` is the function a real relay's descriptor has to
 * satisfy, signatures and certificates included, and it needs no network to ask.
 *
 * Reads the document on stdin. With no argument it is a router descriptor; `cert` makes it an
 * authority key certificate; `vote` and `consensus` a network status.
 *
 * ## What a verdict is worth, per document
 *
 * ACCEPTED does not mean the same thing for all four, and the difference decides what a test built on
 * this may claim. Measured by corrupting each document and asking:
 *
 *   | document        | signature corrupted | body corrupted |
 *   |-----------------|---------------------|----------------|
 *   | descriptor      | REJECTED            | REJECTED       |
 *   | key certificate | REJECTED            | REJECTED       |
 *   | vote            | REJECTED            | REJECTED       |
 *   | **consensus**   | **ACCEPTED**        | **ACCEPTED**   |
 *
 * The first three verify signatures inside the parse. A vote does because it embeds the authority's
 * key certificate, so it can be checked standing alone. A **consensus cannot** — its signatures are
 * made by other authorities whose certificates arrive separately, so
 * `networkstatus_parse_vote_from_string` checks structure and digests and nothing else, and
 * `networkstatus_check_consensus_signature` is the missing second step. Treat a consensus ACCEPTED as
 * "well-formed", never as "correctly signed".
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
#include <unistd.h>
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
#include "app/config/config.h"
#include "app/main/subsysmgr.h"
#include "lib/evloop/compat_libevent.h"
#include "feature/control/control_events.h"
#include "core/or/protover.h"
#include "feature/stats/rephist.h"
#include "feature/stats/bwhist.h"
#include "core/mainloop/mainloop.h"
#include "feature/dirparse/ns_parse.h"
#include "feature/nodelist/networkstatus_st.h"
#include <sys/stat.h>

int main(int argc, char **argv) {
  subsystems_init();
  init_logging(1);
  /* Without a log destination tor's own diagnosis of a rejected document goes nowhere, and an
   * assertion failure aborts silently — which is a slow way to find out that the parser wanted more
   * initialisation than it was given. Warnings and worse to stderr, so stdout stays exactly the
   * verdict a caller parses. */
  {
    log_severity_list_t sev;
    set_log_severity_config(LOG_WARN, LOG_ERR, &sev);
    add_stream_log(&sev, "stderr", STDERR_FILENO);
  }
  /* The recipe is tor's own test harness, src/test/testing_common.c. The network-status parser needs
   * most of it; the descriptor and certificate parsers need almost none. */
  {
    or_options_t *options = options_new();
    struct tor_libevent_cfg_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    tor_libevent_initialize(&cfg);
    control_initialize_event_queue();
    init_protocol_warning_severity_level();
    options->command = CMD_RUN_UNITTESTS;
    if (crypto_global_init(0, NULL, NULL)) { fprintf(stderr, "crypto_global_init failed\n"); return 2; }
    if (crypto_seed_rng() < 0) { fprintf(stderr, "crypto_seed_rng failed\n"); return 2; }
    rep_hist_init();
    bwhist_init();
    initialize_mainloop_events();
    options_init(options);
    const char *dir = "/tmp/parsedesc-probe";
    mkdir(dir, 0700);
    options->DataDirectory = tor_strdup(dir);
    options->DataDirectory_option = tor_strdup(dir);
    tor_asprintf(&options->KeyDirectory, "%s/keys", dir);
    options->CacheDirectory = tor_strdup(dir);
    /* Chutney's voting interval is seconds, and tor enforces a minimum freshness interval unless it is
     * told the network is a test one — which is what chutney's own torrc says. Without this, a vote a
     * chutney authority produced is rejected as "freshness interval is too short", which is tor
     * disagreeing with its own configuration rather than with the document. */
    options->TestingTorNetwork = 1;
    char *errmsg = NULL;
    if (set_options(options, &errmsg) < 0) {
      fprintf(stderr, "set_options failed: %s\n", errmsg ? errmsg : "(none)");
      return 2;
    }
  }

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

  if (argc > 1 && (!strcmp(argv[1], "vote") || !strcmp(argv[1], "consensus"))) {
    int is_vote = !strcmp(argv[1], "vote");
    networkstatus_t *ns = networkstatus_parse_vote_from_string(
        buf, len, NULL, is_vote ? NS_TYPE_VOTE : NS_TYPE_CONSENSUS);
    if (!ns) { printf("REJECTED\n"); return 1; }
    printf("ACCEPTED\n");
    printf("type %s\n", is_vote ? "vote" : "consensus");
    printf("valid_after %ld\n", (long)ns->valid_after);
    printf("routerstatuses %d\n",
           ns->routerstatus_list ? smartlist_len(ns->routerstatus_list) : 0);
    return 0;
  }

  routerinfo_t *ri = router_parse_entry_from_string(buf, NULL, 1, 0, NULL, NULL);
  if (!ri) { printf("REJECTED\n"); return 1; }
  printf("ACCEPTED\n");
  printf("nickname %s\n", ri->nickname ? ri->nickname : "(none)");
  printf("or_port %d\n", ri->ipv4_orport);
  /* The digest a vote's `r` line carries, base64 of these 20 bytes with the padding stripped. Printed
   * because the span it covers is not obvious from the document and tor is the only authority on it. */
  {
    char b16[HEX_DIGEST_LEN + 1];
    base16_encode(b16, sizeof(b16), ri->cache_info.signed_descriptor_digest, DIGEST_LEN);
    printf("descriptor_digest %s\n", b16);
  }
  printf("bandwidth %u %u %u\n", (unsigned)ri->bandwidthrate,
         (unsigned)ri->bandwidthburst, (unsigned)ri->bandwidthcapacity);
  return 0;
}
