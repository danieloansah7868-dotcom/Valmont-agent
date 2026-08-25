# syntax=docker/dockerfile:1.7
# Valmont task sandbox image — see compose.sandbox.yaml and
# src/lib/workspace-docker.ts.
#
# The image is inert and credential-free. The provider starts one container
# per coding task and execs git/node/npm into it as the unprivileged `node`
# user. Runtime hardening (read-only rootfs, dropped capabilities,
# no-new-privileges, default seccomp profile, default-deny network, and
# CPU/memory/PID quotas) is applied by the provider at `docker create` time
# and mirrored in compose.sandbox.yaml for the runtime smoke test.
FROM node:22.13-bookworm-slim

LABEL org.opencontainers.image.title="valmont-sandbox" \
      org.opencontainers.image.description="Ephemeral per-task sandbox for Valmont Agent workspace execution"

ENV NEXT_TELEMETRY_DISABLED=1 \
    HOME=/workspace/.home \
    TMPDIR=/workspace/.tmp

# git for workspace baselines and diffs; ca-certificates for dependency
# access when a narrowly proxied egress route is configured. Package-manager
# scratch ($HOME, TMPDIR) lives on the task volume, not on the host: the
# runtime rootfs is read-only and the only mount is the task's named volume.
# `.home`/`.tmp` are excluded from the workspace git baseline.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm cache clean --force \
    && mkdir -p /workspace/.home /workspace/.tmp \
    && chown -R node:node /workspace

# Fixed bootstrap (no external input): create the per-task scratch directories
# on the fresh volume, fix ownership, then drop to the unprivileged user.
# Every task-code exec performed by the provider passes `--user node`
# explicitly; this process never accepts untrusted input.
CMD ["sh", "-c", "mkdir -p /workspace/.home /workspace/.tmp && chown node:node /workspace/.home /workspace/.tmp && exec setpriv --reuid=node --regid=node --clear-groups sleep infinity"]
