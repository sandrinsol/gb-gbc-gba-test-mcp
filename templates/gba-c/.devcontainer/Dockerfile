# Game Boy / Color / Advance toolchains: RGBDS (asm), GBDK-2020 (C) and
# arm-none-eabi GCC (GBA C). x86-64 only: the RGBDS and GBDK releases are.
FROM --platform=linux/amd64 ubuntu:24.04

ARG RGBDS_VERSION=0.9.1
ARG GBDK_VERSION=4.3.0

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git make xz-utils sudo \
      gcc-arm-none-eabi binutils-arm-none-eabi libnewlib-arm-none-eabi \
 && rm -rf /var/lib/apt/lists/*

RUN curl -sSL "https://github.com/gbdev/rgbds/releases/download/v${RGBDS_VERSION}/rgbds-${RGBDS_VERSION}-linux-x86_64.tar.xz" \
      | tar -xJ -C /usr/local/bin rgbasm rgblink rgbfix rgbgfx \
 && curl -sSL "https://github.com/gbdk-2020/gbdk-2020/releases/download/${GBDK_VERSION}/gbdk-linux64.tar.gz" \
      | tar -xz -C /opt

ENV GBDK=/opt/gbdk
