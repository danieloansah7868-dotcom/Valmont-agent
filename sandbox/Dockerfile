# Valmont sandbox image — the inert base for DockerWorkspaceProvider.
#
# The container runs as the unprivileged `node` user from CREATE time
# (`docker create --user 1000:1000 --init`; compose.sandbox.yaml mirrors
# that as `user:` + `init: true`). There is deliberately no in-container
# user bootstrap here: under `--cap-drop ALL` a root entrypoint cannot
# chown, and `setpriv` cannot clear supplementary groups or drop
# privileges either — any design that needs one of those cannot run in
# this container at all. Ownership of the workspace is therefore
# established by WHO extracts into it (the provider stages source and
# files with `tar` run as the unprivileged user), not by a later chown.
#
# Everything else the provider needs is a standard toolchain:
# bash, git, tar, and coreutils. No agent runtimes are installed.

FROM node:22.13-bookworm-slim

# Non-root user the container runs as (uid/gid 1000 in the base image).
# git is required by the provider's baseline/diff operations; ca-certs is
# standard for package managers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# /workspace is a per-task size-capped tmpfs the provider mounts at create
# time (owned by 1000:1000 via the mount's uid=/gid= options); the layer
# copy below is hidden by that mount and exists so the image builds and
# runs standalone. Package-manager scratch ($HOME, TMPDIR) lives on the
# task tmpfs, not on the read-only root.
RUN mkdir -p /workspace/.home /workspace/.tmp && \
    chown -R node:node /workspace
ENV HOME=/workspace/.home \
    TMPDIR=/workspace/.tmp

# Inert command; the provider never depends on the image entrypoint doing
# anything (validation commands are exec'd explicitly, and --init gives
# the container a zombie-reaping PID 1).
CMD ["sleep", "infinity"]
