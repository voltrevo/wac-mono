#!/bin/sh
# Build tor from source, for the ntor differential in packages/tor.
#
# Not committed and not required to run the suite — but its absence is reported as a
# failure rather than a skip, because a differential that quietly stops running leaves the
# suite green while checking nothing. That happened to the SHAKE tests here for months.
#
# The real Tor network is not reachable from this sandbox: the directory authorities are
# IP-addressed and the proxy allowlist is by domain, so they answer 403, and
# torproject.org is blocked outright. github.com is reachable, which is why this fetches
# the mirror.
#
# What it gives you is `test-ntor-cl`, tor's own command-line ntor implementation, which is
# the only independent check of the handshake available offline.
set -e
DIR="${1:-/tmp/tor-build}"
TAG="${TOR_TAG:-tor-0.4.7.13}"

command -v aclocal >/dev/null 2>&1 || sudo apt-get install -y -qq \
  automake autoconf libtool libevent-dev libssl-dev zlib1g-dev pkg-config

mkdir -p "$DIR"
cd "$DIR"
[ -f tor.tar.gz ] || curl -sL -o tor.tar.gz \
  "https://api.github.com/repos/torproject/tor/tarball/refs/tags/$TAG"
[ -d torproject-tor-* ] 2>/dev/null || tar xzf tor.tar.gz
cd torproject-tor-*

[ -f configure ] || ./autogen.sh
# Relay mode stays *enabled*. `--disable-module-relay` builds a client-only tor, which is
# fine for the ntor oracle and useless for a testnet — chutney is all relays and directory
# authorities, and the failure is `This tor was built with relay mode disabled` from a
# `--list-fingerprint` deep inside chutney's Python, which reads as a chutney problem.
# I have now hit this twice: once building the oracle, and once rebuilding after the
# container was recreated, because the first time I fixed the build by hand and not the
# script. Check `relay: yes, dirauth: yes` in configure's summary.
[ -f Makefile ] || ./configure --disable-asciidoc --disable-manpage \
  --disable-html-manual
make -j"$(nproc)" src/test/test-ntor-cl

echo
echo "built: $PWD/src/test/test-ntor-cl"
echo "point the tests at it with:"
echo "  export TOR_NTOR_CL=$PWD/src/test/test-ntor-cl"
