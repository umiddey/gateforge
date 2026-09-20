# gateforge controller containerfile (plan Phase 10).
# Pinned base; no candidate bytes at build time — the candidate is
# mounted read-only at run time by the managed runtime.
#
# The owner MUST supply the currently approved Fedora digest at build time:
#   podman build --build-arg FEDORA_BASE_DIGEST=sha256:<64-hex> ...
# Digest updates are an owner-controlled image revision, not a candidate
# setting. There is intentionally no placeholder or floating-tag fallback.
ARG FEDORA_BASE_DIGEST
FROM quay.io/fedora/fedora@${FEDORA_BASE_DIGEST}

# Re-declare the pre-FROM ARG in the build stage and fail closed if the
# caller supplied anything other than a complete immutable digest. The
# registry then verifies that the referenced digest exists.
ARG FEDORA_BASE_DIGEST
RUN case "$FEDORA_BASE_DIGEST" in \
      sha256:*) digest="${FEDORA_BASE_DIGEST#sha256:}"; \
        test "${#digest}" -eq 64 && \
        case "$digest" in *[!0-9a-f]*) exit 1 ;; esac ;; \
      *) echo "FEDORA_BASE_DIGEST must be an owner-supplied sha256:<64-hex> digest" >&2; exit 1 ;; \
    esac

# Rootless-ready: all engine deps and the fixed non-root runtime identity
# are inside the image so `--user gateforge-runner` resolves at launch.
RUN dnf -y install nodejs git git-lfs && dnf clean all
RUN useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin gateforge-runner

# The gateforge engine is installed from the owner-provisioned approved
# bundle mounted at /engine (read-only) — never bundled into the image,
# so an image swap can never smuggle engine code past the bundle pin.
ENV NODE_ENV=production
WORKDIR /work

# Fixed entrypoint matching the published npm engine bundle; the isolation
# controller supplies only the bounded `controller` argument.
ENTRYPOINT ["node", "/engine/bin/gateforge.js"]
CMD ["controller"]
