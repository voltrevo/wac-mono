#!/bin/sh
# A three-certificate chain shaped like the ones on the public web: a P-384 root, a P-256
# intermediate signed with ecdsa-with-SHA384, and a P-256 leaf signed with SHA-256.
#
# That shape is the reason P-384 is implemented at all. github.com's chain is P-256 all
# the way up and still needs P-384, because the Sectigo root it terminates at is P-384 —
# so a client without it builds the whole path and then has no anchor. Mixing the hash
# and the curve across levels is deliberate too: the signature algorithm and the signer's
# key type are independent, and code that assumes SHA-384 implies P-384 passes a chain
# where they happen to agree and fails this one.
#
# Dates are fixed and long so the fixtures are not time bombs; the tests pass an explicit
# `now` rather than reading the clock.
set -e
OPENSSL="${OPENSSL:-openssl}"
D=$(dirname "$0")
cd "$D"

conf() { printf '%s\n' "$@"; }

$OPENSSL ecparam -name secp384r1 -genkey -noout -out p384_root.key
conf "[req]" "distinguished_name=dn" "prompt=no" "[dn]" "CN=wac P-384 test root" \
     "[ext]" "basicConstraints=critical,CA:TRUE" "keyUsage=critical,keyCertSign,cRLSign" > p384_root.cnf
$OPENSSL req -new -x509 -key p384_root.key -sha384 -out p384_root.pem \
  -config p384_root.cnf -extensions ext -set_serial 1 \
  -not_before 20200101000000Z -not_after 20450101000000Z

$OPENSSL ecparam -name prime256v1 -genkey -noout -out p384_inter.key
conf "[req]" "distinguished_name=dn" "prompt=no" "[dn]" "CN=wac test intermediate" > p384_inter.cnf
$OPENSSL req -new -key p384_inter.key -out p384_inter.csr -config p384_inter.cnf
conf "basicConstraints=critical,CA:TRUE,pathlen:0" "keyUsage=critical,keyCertSign,cRLSign" > p384_inter.ext
# Signed by the P-384 root with SHA-384: the case that needs P-384 verification.
$OPENSSL x509 -req -in p384_inter.csr -CA p384_root.pem -CAkey p384_root.key -sha384 \
  -out p384_inter.pem -extfile p384_inter.ext -set_serial 2 \
  -not_before 20200101000000Z -not_after 20450101000000Z

$OPENSSL ecparam -name prime256v1 -genkey -noout -out p384_leaf.key
conf "[req]" "distinguished_name=dn" "prompt=no" "[dn]" "CN=wac.test" > p384_leaf.cnf
$OPENSSL req -new -key p384_leaf.key -out p384_leaf.csr -config p384_leaf.cnf
conf "basicConstraints=critical,CA:FALSE" "subjectAltName=DNS:wac.test,DNS:*.wac.test" \
     "keyUsage=critical,digitalSignature" > p384_leaf.ext
$OPENSSL x509 -req -in p384_leaf.csr -CA p384_inter.pem -CAkey p384_inter.key -sha256 \
  -out p384_leaf.pem -extfile p384_leaf.ext -set_serial 3 \
  -not_before 20200101000000Z -not_after 20450101000000Z

# An imposter: the same subject name as the root, a different key. Name matching alone
# would accept it, so it is what proves the signature is checked and not just the issuer
# string. Two real authorities sharing a subject name is not hypothetical — it is why
# verifyPath keeps looking after a name matches but the signature does not.
$OPENSSL ecparam -name secp384r1 -genkey -noout -out p384_imposter.key
$OPENSSL req -new -x509 -key p384_imposter.key -sha384 -out p384_imposter.pem \
  -config p384_root.cnf -extensions ext -set_serial 4 \
  -not_before 20200101000000Z -not_after 20450101000000Z

# ── Variants for the path-validation rules ───────────────────────────────────
#
# Every leaf variant is signed by p384_inter.key and carries the same subject, so the
# ordinary intermediate vouches for all of them; every intermediate variant is built from
# the same CSR, so it has the same key and subject as p384_inter and the ordinary leaf
# chains through any of them. That means one difference per fixture and nothing else.

leaf_variant() {  # name, extra extension line
  conf "basicConstraints=critical,CA:FALSE" "subjectAltName=DNS:wac.test,DNS:*.wac.test" \
       "keyUsage=critical,digitalSignature" "$2" > $1.ext
  $OPENSSL x509 -req -in p384_leaf.csr -CA p384_inter.pem -CAkey p384_inter.key -sha256 \
    -out $1.pem -extfile $1.ext -set_serial 10 \
    -not_before 20200101000000Z -not_after 20450101000000Z
}

inter_variant() { # name, extra extension line
  conf "basicConstraints=critical,CA:TRUE,pathlen:0" "keyUsage=critical,keyCertSign,cRLSign" \
       "$2" > $1.ext
  $OPENSSL x509 -req -in p384_inter.csr -CA p384_root.pem -CAkey p384_root.key -sha384 \
    -out $1.pem -extfile $1.ext -set_serial 11 \
    -not_before 20200101000000Z -not_after 20450101000000Z
}

# A critical extension under a private arc nothing will ever recognise. RFC 5280 says
# reject; the value is an ASN.1 NULL and is beside the point.
leaf_variant p384_leaf_crit "1.3.6.1.4.1.99999.1=critical,DER:05:00"
# The same extension marked non-critical, which must be ignored rather than rejected.
leaf_variant p384_leaf_noncrit "1.3.6.1.4.1.99999.1=DER:05:00"
# Issued for authenticating a client, not a server. A valid certificate for something else.
leaf_variant p384_leaf_clientauth "extendedKeyUsage=clientAuth"
# Explicitly for servers, so the check is not just "EKU absent works".
leaf_variant p384_leaf_serverauth "extendedKeyUsage=serverAuth,clientAuth"

# A CA constrained to the namespace its leaf is actually in, and one constrained elsewhere.
inter_variant p384_nc_ok  "nameConstraints=critical,permitted;DNS:wac.test"
inter_variant p384_nc_bad "nameConstraints=critical,permitted;DNS:other.test"
inter_variant p384_nc_excl "nameConstraints=critical,excluded;DNS:wac.test"
# A constraint on a name form this does not enforce, which must make the CA unusable
# rather than be applied in part.
inter_variant p384_nc_ip "nameConstraints=critical,permitted;IP:10.0.0.0/255.0.0.0"
# `wac.test` ends with `c.test` and is not inside it. A subtree match written as a plain
# string suffix accepts this, which is how a constrained CA escapes its namespace by
# registering a domain with the right last letters.
inter_variant p384_nc_suffix "nameConstraints=critical,permitted;DNS:c.test"

for n in p384_root p384_inter p384_leaf p384_imposter; do
  $OPENSSL x509 -in $n.pem -outform der -out $n.der
done
rm -f p384_*.cnf p384_*.ext
$OPENSSL verify -CAfile p384_root.pem -untrusted p384_inter.pem p384_leaf.pem
