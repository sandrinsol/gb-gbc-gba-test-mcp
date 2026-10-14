# devkitPro's own image (devkitARM, grit, Maxmod) plus Butano.
FROM devkitpro/devkitarm:latest

ARG BUTANO_VERSION=21.9.0
RUN git clone --depth 1 --branch "${BUTANO_VERSION}" https://github.com/GValiente/butano /opt/butano
ENV BUTANO=/opt/butano
