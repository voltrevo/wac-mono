/* Blind an ed25519 keypair with tor's own code, so ours can be compared against it.
 *
 * The oracle for the *service* half of key blinding. `hsblind.wac` already derives the blinded
 * **public** key, which is all a client needs and which is pinned against a key tor published. A
 * service needs the blinded **secret**, because the descriptor's signing-key certificate is signed
 * with it — and nothing in the descriptor says which key signed, so a wrong derivation produces a
 * document that decodes perfectly for anyone who does not know the identity key. That is precisely
 * the failure an oracle has to catch, and no descriptor-level check can.
 *
 * Prints tor's blinded secret (64 bytes: scalar then prefix) and blinded public key.
 *
 *   blind-probe <identity-seed-hex-32> <blinding-param-hex-32>
 *
 * The blinding parameter is the already-clamped factor `hsblind.wac`'s `blindingFactor` produces;
 * tor's `ed25519_donna_gettweak` applies the same three masks, so passing a clamped value through is
 * idempotent and the two agree on what the parameter means.
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
#include "lib/crypt_ops/crypto_init.h"
#include "lib/crypt_ops/crypto_ed25519.h"
#include "lib/log/log.h"

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

int
main(int argc, char **argv)
{
  if (argc < 3) {
    fprintf(stderr, "usage: blind-probe <identity-seed-hex> <blinding-param-hex>\n");
    return 2;
  }
  init_logging(1);
  if (crypto_global_init(0, NULL, NULL) < 0) {
    fprintf(stderr, "crypto_global_init failed\n");
    return 2;
  }

  uint8_t seed[32], param[32];
  if (unhex(argv[1], seed, sizeof(seed)) || unhex(argv[2], param, sizeof(param))) {
    fprintf(stderr, "arguments must be 32 bytes of hex each\n");
    return 2;
  }

  /* The identity keypair, expanded from the seed exactly as any ed25519 implementation does. */
  ed25519_keypair_t kp;
  if (ed25519_secret_key_from_seed(&kp.seckey, seed) < 0) {
    fprintf(stderr, "ed25519_secret_key_from_seed failed\n");
    return 2;
  }
  if (ed25519_public_key_generate(&kp.pubkey, &kp.seckey) < 0) {
    fprintf(stderr, "ed25519_public_key_generate failed\n");
    return 2;
  }
  puthex("identity_secret", kp.seckey.seckey, 64);
  puthex("identity_public", kp.pubkey.pubkey, 32);

  ed25519_keypair_t blinded;
  if (ed25519_keypair_blind(&blinded, &kp, param) < 0) {
    printf("FAILED\nreason: ed25519_keypair_blind\n");
    return 1;
  }
  puthex("blinded_secret", blinded.seckey.seckey, 64);
  puthex("blinded_public", blinded.pubkey.pubkey, 32);

  /* And a signature made with the blinded key, because the derivation is only useful if what it
   * produces signs — a scalar that is wrong by a factor of the cofactor still looks like a scalar. */
  {
    ed25519_signature_t sig;
    const char msg[] = "wac-mono blinded signing check";
    if (ed25519_sign(&sig, (const uint8_t *)msg, strlen(msg), &blinded) < 0) {
      printf("FAILED\nreason: ed25519_sign with the blinded key\n");
      return 1;
    }
    puthex("signature", sig.sig, 64);
    printf("message: %s\n", msg);
  }

  printf("OK\n");
  return 0;
}
