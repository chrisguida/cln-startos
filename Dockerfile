ARG CLN_VERSION=v26.06.9

# Shared base with common dependencies
FROM debian:bookworm-slim AS base
RUN apt-get update -qq && \
    apt-get install -qq -y --no-install-recommends \
    build-essential \
    git \
    pkg-config \
    curl && \
    rm -rf /var/lib/apt/lists/*

# clboss builder
FROM base AS clboss
RUN apt-get update -qq && \
    apt-get install -qq -y --no-install-recommends \
    autoconf-archive \
    automake \
    libcurl4-gnutls-dev \
    libev-dev \
    libsqlite3-dev \
    libtool \
    libunwind-dev && \
    rm -rf /var/lib/apt/lists/*

COPY clboss/. /tmp/clboss
WORKDIR /tmp/clboss
RUN autoreconf -i && \
    ./configure && \
    ./generate_commit_hash.sh && \
    make -j$(nproc) && \
    make install && \
    strip /usr/local/bin/clboss

# sling - download prebuilt binary
FROM base AS sling
ARG TARGETARCH
ARG SLING_VERSION=v4.3.1
RUN apt-get update -qq && apt-get install -qq -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && \
    if [ "$TARGETARCH" = "amd64" ]; then SLING_ARCH=x86_64; else SLING_ARCH=aarch64; fi && \
    curl -fSL "https://github.com/daywalker90/sling/releases/download/${SLING_VERSION}/sling-${SLING_VERSION}-${SLING_ARCH}-linux-gnu.tar.gz" \
    | tar xz -C /usr/local/bin/

# Rust toolchain, shared by rust-teos and the lightningd source build
FROM base AS rust-base
ENV RUST_PROFILE=release \
    PATH="/root/.cargo/bin:/root/.local/bin:$PATH" \
    PROTOBUF_VERSION=21.12 \
    PROTOC=/usr/bin/protoc \
    PROTOC_INCLUDE=/usr/local/include

RUN apt-get update -qq && \
    apt-get install -qq -y --no-install-recommends \
    autoconf automake ca-certificates dirmngr gettext \
    gnupg jq libpq-dev libtool libffi-dev libssl-dev \
    protobuf-compiler libev-dev libevent-dev \
    qemu-user-static wget unzip tclsh && \
    rm -rf /var/lib/apt/lists/* && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && \
    rustup toolchain install stable --component rustfmt --allow-downgrade && \
    curl -fsSLO --retry 3 https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOBUF_VERSION}/protobuf-all-${PROTOBUF_VERSION}.tar.gz && \
    tar -xzf protobuf-all-${PROTOBUF_VERSION}.tar.gz && \
    cp -r protobuf-${PROTOBUF_VERSION}/src/google /usr/local/include/ && \
    rm -rf protobuf*

# rust-teos builder
FROM rust-base AS builder-rust
COPY ./rust-teos /tmp/rust-teos
WORKDIR /tmp/rust-teos
RUN cargo install --locked --path teos && \
    cargo install --locked --path watchtower-plugin

# Two Core Lightning builds, each under its own prefix. lightningd finds its
# subdaemons and builtin plugins relative to its own binary, so each prefix is
# complete on its own.
#
# - /opt/cln-sha256d: upstream v26.06.9. Runs the node's existing database on
#   the SHA256d chain during a recovery (Close All, Withdraw), and never opens
#   a database the fork has upgraded.
# - /usr/local: privkeyio v26.06.10-blake2b.1, which reads the 164-byte BLAKE2b
#   block header and signs wallet spends with the unified sighash. Runs the
#   BLAKE2b instance during a recovery, and the node afterwards.
#
# Upstream hashes come from SHA256SUMS-v26.06.9 and -arm64, GPG-verified
# against maintainer key 4E4A142F8BD3C38A56B362ED578CAC08472545C5.
FROM base AS lightningd-tarball
ARG TARGETARCH
ARG CLN_VERSION
ARG CLN_SHA256_AMD64=da19bd04de3ebb2ae525cfc114b69bf45ce1c53fad7877d011b4fcaeacf0e45a
ARG CLN_SHA256_ARM64=8bff3b55e41078fc98fb2f0bc454b975aed6fa858c4fe8d7a77e711f2a73e97e
RUN apt-get update -qq && \
    apt-get install -qq -y --no-install-recommends ca-certificates xz-utils && \
    rm -rf /var/lib/apt/lists/*
# Ubuntu 22.04 build: its glibc 2.35 runs on bookworm's 2.36, so the runtime
# stays the distro every other binary here is compiled against.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) SHA="$CLN_SHA256_AMD64" ;; \
      arm64) SHA="$CLN_SHA256_ARM64" ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    TARBALL="clightning-${CLN_VERSION}-Ubuntu-22.04-${TARGETARCH}.tar.xz"; \
    curl -fsSLO "https://github.com/ElementsProject/lightning/releases/download/${CLN_VERSION}/${TARBALL}"; \
    echo "${SHA}  ${TARBALL}" | sha256sum -c -; \
    mkdir -p /dist/opt/cln-sha256d; \
    tar -xf "$TARBALL" -C /dist/opt/cln-sha256d --strip-components=2

# lightningd built from the release's source zip, for an arch upstream
# published no tarball for. The hash is from the same signed SHA256SUMS.
FROM rust-base AS lightningd-source
ARG CLN_VERSION
ARG CLN_SRC_SHA256=ac37b1b6c41b6c60cf06dd8cd7500f1fab04411cf2f3bc126838d8cafab4538d
RUN apt-get update -qq && \
    apt-get install -qq -y --no-install-recommends \
    libsodium-dev libsqlite3-dev zlib1g-dev python3-mako lowdown unzip && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /tmp
RUN set -eu; \
    ZIP="clightning-${CLN_VERSION}.zip"; \
    curl -fsSLO --retry 3 "https://github.com/ElementsProject/lightning/releases/download/${CLN_VERSION}/${ZIP}"; \
    echo "${CLN_SRC_SHA256}  ${ZIP}" | sha256sum -c -; \
    unzip -q "$ZIP"; \
    cd "clightning-${CLN_VERSION}"; \
    ./configure --prefix=/opt/cln-sha256d --disable-valgrind; \
    make -j"$(nproc)" install-program DESTDIR=/dist RUST_PROFILE=release VERSION="${CLN_VERSION}"

FROM lightningd-tarball AS lightningd-dist-amd64
FROM lightningd-tarball AS lightningd-dist-arm64
FROM lightningd-dist-${TARGETARCH} AS lightningd-dist

# The BLAKE2b fork, from its signed release tarballs. The hashes come from
# SHA256SUMS-v26.06.10-blake2b.1 and -arm64 of the privkeyio/lightning
# release, GPG-verified against A47D99B6DB0D715D40C59A2023AE8A8EA7E24E38.
FROM base AS lightningd-blake2b
ARG TARGETARCH
ARG BLAKE2B_REPO=privkeyio/lightning
ARG BLAKE2B_VERSION=v26.06.10-blake2b.1
ARG BLAKE2B_SHA256_AMD64=b3e7af0e376ae1f6b22f16c416a86474f6ab3c4d44c5aa6ef1a4a848a4cd9c72
ARG BLAKE2B_SHA256_ARM64=7a54f4821acdf773c6f90ccb6fafdd2f5fda9e557f272311fc5b7b8862842ad6
RUN apt-get update -qq && \
    apt-get install -qq -y --no-install-recommends ca-certificates xz-utils && \
    rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) SHA="$BLAKE2B_SHA256_AMD64" ;; \
      arm64) SHA="$BLAKE2B_SHA256_ARM64" ;; \
      *) echo "no ${BLAKE2B_VERSION} build for TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    TARBALL="clightning-${BLAKE2B_VERSION}-Ubuntu-22.04-${TARGETARCH}.tar.xz"; \
    curl -fsSLO "https://github.com/${BLAKE2B_REPO}/releases/download/${BLAKE2B_VERSION}/${TARBALL}"; \
    echo "${SHA}  ${TARBALL}" | sha256sum -c -; \
    mkdir -p /dist/usr/local; \
    tar -xf "$TARBALL" -C /dist/usr/local --strip-components=2

# bitcoin-cli, which CLN's own plugin-bcli and our check-synced health check
# both exec; without it lightningd dies at startup with "The Bitcoin backend
# died". Checksums are from bitcoincore.org's SHA256SUMS.
FROM base AS bitcoin-cli
ARG TARGETARCH
ARG BITCOIN_VERSION=31.1
ARG BITCOIN_SHA256_AMD64=b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e
ARG BITCOIN_SHA256_ARM64=dcf1873f2208ba4f962f3398d47e154c39c0084be8f4553e05c940d0ace3d004
RUN apt-get update -qq && \
    apt-get install -qq -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) SHA="$BITCOIN_SHA256_AMD64"; ARCH=x86_64 ;; \
      arm64) SHA="$BITCOIN_SHA256_ARM64"; ARCH=aarch64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    TARBALL="bitcoin-${BITCOIN_VERSION}-${ARCH}-linux-gnu.tar.gz"; \
    curl -fsSLO "https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}/${TARBALL}"; \
    echo "${SHA}  ${TARBALL}" | sha256sum -c -; \
    tar -xf "$TARBALL" "bitcoin-${BITCOIN_VERSION}/bin/bitcoin-cli"; \
    install -m 755 "bitcoin-${BITCOIN_VERSION}/bin/bitcoin-cli" /usr/bin/bitcoin-cli

# Final stage - simplified
#
# `ca-certificates` is load-bearing: the slim base carries no CA store, and none
# of the -dev packages below pull one in. Without it watchtower-client cannot
# build an HTTPS client, so no tower ever registers (see README.md).
#
# `libpq5` and `libsodium23` are lightningd's own runtime deps.
#
# `sqlite3` is for the Recovery actions: a consistent copy of lightningd's
# database (`.backup`) and read-only queries on it while lightningd is stopped.
FROM debian:bookworm-slim AS final
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates libev-dev libcurl4-gnutls-dev libsqlite3-dev libunwind-dev \
    libpq5 libsodium23 wireguard-tools iptables iproute2 procps sqlite3 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=bitcoin-cli /usr/bin/bitcoin-cli /usr/bin/bitcoin-cli
COPY --from=lightningd-blake2b /dist/usr/local /usr/local
COPY --from=lightningd-dist /dist/opt/cln-sha256d /opt/cln-sha256d
COPY --from=clboss /usr/local/bin/clboss /usr/local/libexec/c-lightning/plugins/
COPY --from=builder-rust /root/.cargo/bin/teos* /usr/local/bin/
COPY --from=builder-rust /root/.cargo/bin/watchtower-client /usr/local/libexec/c-lightning/plugins/
COPY --from=sling /usr/local/bin/sling /usr/local/libexec/c-lightning/plugins/
