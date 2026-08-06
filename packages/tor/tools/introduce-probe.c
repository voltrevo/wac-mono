/* Build an INTRODUCE1 cell with tor, and parse one with tor. Both directions of the same seam.
 *
 * The oracle for `parseIntroduce2` in `src/hsservice.wac`. An INTRODUCE2 is byte-for-byte an
 * INTRODUCE1 — the introduction point relays the body unchanged and only the relay command differs —
 * so a service's parser and a client's builder are two ends of one format, and this repo now has
 * both. Testing one against the other would be the symmetric oracle this project has been caught by
 * before: a builder and a parser that share a mistake agree perfectly.
 *
 * So:
 *
 * There is one mode, `build`: tor writes the cell and our service parses it, which is the direction
 * the new code is in.
 *
 * **The other direction is not available from a probe like this**, and the reason is worth recording
 * so nobody spends the hour I nearly did. `hs_cell_parse_introduce2` asserts on its `circ` argument
 * (`hs_cell.c:831`) — it needs a real `origin_circuit_t` for replay caching, so passing NULL aborts
 * rather than returning an error. Feeding one of *our* cells to tor's parser therefore needs a
 * running service, which is a chutney network rather than a probe. Until then our client's builder is
 * covered only by `hsintro.wac`'s own vectors.
 *
 * Every value is hex on the command line, so nothing here needs a network or a running service.
 *
 *   introduce-probe build <auth_pk> <enc_pk> <subcred> <onion_pk> <cookie> <client_sk> <out-file>
 *   introduce-probe parse <auth_pk> <enc_sk> <subcred> <cell-file>
 *
 * Build it the way capture-prop228.py builds its probe — against a configured and built tor tree's
 * libtor.a.
 */
#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include "orconfig.h"
#include "core/or/or.h"
#include "feature/hs/hs_cell.h"
#include "feature/hs/hs_common.h"
#include "lib/crypt_ops/crypto_init.h"
#include "lib/crypt_ops/crypto_ed25519.h"
#include "lib/crypt_ops/crypto_curve25519.h"
#include "lib/crypt_ops/crypto_format.h"
#include "lib/log/log.h"
#include "app/config/config.h"
#include "app/main/subsysmgr.h"
#include "trunnel/link_handshake.h"
#include "core/or/extendinfo.h"

static int
unhex(const char *s, uint8_t *out, size_t want)
{
  size_t n = strlen(s);
  while (n > 0 && (s[n - 1] == '\n' || s[n - 1] == '\r')) n--;
  if (n != want * 2) return -1;
  for (size_t i = 0; i < want; i++) {
    unsigned v;
    if (sscanf(s + i * 2, "%2x", &v) != 1) return -1;
    out[i] = (uint8_t)v;
  }
  return 0;
}

static void
puthex(const char *label, const uint8_t *b, size_t n)
{
  printf("%s: ", label);
  for (size_t i = 0; i < n; i++) printf("%02x", b[i]);
  printf("\n");
}

static void
setup(void)
{
  subsystems_init();
  init_logging(1);
  {
    log_severity_list_t sev;
    set_log_severity_config(LOG_WARN, LOG_ERR, &sev);
    add_stream_log(&sev, "stderr", STDERR_FILENO);
  }
  if (crypto_global_init(0, NULL, NULL) < 0) {
    fprintf(stderr, "crypto_global_init failed\n");
    exit(2);
  }
}

/** One IPv4 link specifier, so the encrypted section carries a realistic list. */
static smartlist_t *
one_link_specifier(void)
{
  smartlist_t *lst = smartlist_new();
  link_specifier_t *ls = link_specifier_new();
  link_specifier_set_ls_type(ls, LS_IPV4);
  link_specifier_set_un_ipv4_addr(ls, 0x7f000001);   /* 127.0.0.1 */
  link_specifier_set_un_ipv4_port(ls, 9001);
  link_specifier_set_ls_len(ls, 6);
  smartlist_add(lst, ls);
  return lst;
}

static int
do_build(int argc, char **argv)
{
  if (argc < 9) { fprintf(stderr, "build needs six hex values and an output path\n"); return 2; }

  ed25519_public_key_t auth_pk;
  curve25519_public_key_t enc_pk, onion_pk;
  hs_subcredential_t subcred;
  uint8_t cookie[REND_COOKIE_LEN];
  curve25519_keypair_t client_kp;

  if (unhex(argv[2], auth_pk.pubkey, ED25519_PUBKEY_LEN) ||
      unhex(argv[3], enc_pk.public_key, CURVE25519_PUBKEY_LEN) ||
      unhex(argv[4], subcred.subcred, DIGEST256_LEN) ||
      unhex(argv[5], onion_pk.public_key, CURVE25519_PUBKEY_LEN) ||
      unhex(argv[6], cookie, sizeof(cookie)) ||
      unhex(argv[7], client_kp.seckey.secret_key, CURVE25519_SECKEY_LEN)) {
    fprintf(stderr, "an argument is not hex of the right length\n");
    return 2;
  }
  curve25519_public_key_generate(&client_kp.pubkey, &client_kp.seckey);

  hs_cell_introduce1_data_t data;
  memset(&data, 0, sizeof(data));
  data.is_legacy = 0;
  data.auth_pk = &auth_pk;
  data.enc_pk = &enc_pk;
  data.subcredential = &subcred;
  data.onion_pk = &onion_pk;
  data.rendezvous_cookie = cookie;
  data.client_kp = &client_kp;
  data.link_specifiers = one_link_specifier();
  data.cc_enabled = 0;

  uint8_t out[RELAY_PAYLOAD_SIZE];
  memset(out, 0, sizeof(out));
  ssize_t n = hs_cell_build_introduce1(&data, out);
  if (n <= 0) {
    printf("FAILED\nreason: hs_cell_build_introduce1 returned %d\n", (int)n);
    return 1;
  }

  FILE *fp = fopen(argv[8], "wb");
  if (!fp) { fprintf(stderr, "cannot write %s\n", argv[8]); return 2; }
  fwrite(out, 1, (size_t)n, fp);
  fclose(fp);

  printf("cell_bytes: %d\n", (int)n);
  puthex("client_pk", client_kp.pubkey.public_key, CURVE25519_PUBKEY_LEN);
  printf("BUILT\n");
  return 0;
}

int
main(int argc, char **argv)
{
  if (argc < 2) {
    fprintf(stderr, "usage: introduce-probe build <auth_pk> <enc_pk> <subcred> <onion_pk>"
                    " <cookie> <client_sk> <out-file>\n");
    return 2;
  }
  setup();
  if (!strcmp(argv[1], "build")) return do_build(argc, argv);
  fprintf(stderr, "unknown mode %s\n", argv[1]);
  return 2;
}
