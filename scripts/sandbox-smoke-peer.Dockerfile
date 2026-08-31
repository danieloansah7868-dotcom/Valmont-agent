# Valmont sandbox smoke test — the SECOND-HOST peer image.
#
# Node (to run the bundled provider) plus the Docker CLI (to reach the
# peer's own docker:dind daemon via DOCKER_HOST over TCP — the peer never
# touches the first host's docker socket). `tar` and coreutils are already
# in the base image; the provider needs them for host-side source staging.
#
# Built by scripts/sandbox-smoke.ts, which places provider.cjs (the
# esbuild bundle of src/lib/workspace-docker.ts) and peer-driver.cjs next
# to this file before `docker build`.
FROM node:22.13-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /peer
COPY provider.cjs peer-driver.cjs ./

ENTRYPOINT ["node", "/peer/peer-driver.cjs"]
