FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68

ARG NPM_REGISTRY

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates make python3 procps curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm $([ -n "$NPM_REGISTRY" ] && echo "--registry=$NPM_REGISTRY") install --global --no-audit --no-fund @deepseek-ai/dsh@0.2.1-rc.5 pnpm@12.16.1

WORKDIR /opt/forgeloop
RUN chown node:node /opt/forgeloop
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/forgeloop/package.json ./packages/forgeloop/
USER node
RUN npm $([ -n "$NPM_REGISTRY" ] && echo "--registry=$NPM_REGISTRY") ci --no-audit --no-fund

COPY --chown=node:node . .
ENV DSH_AGENTS_HOME=/home/node/verification-agents \
    DSH_TELEMETRY_DISABLED=1 \
    FORGELOOP_DSH_CLI=/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
RUN git init -q \
    && git config user.name 'ForgeLoop verification' \
    && git config user.email verification@example.invalid \
    && git add -A \
    && git commit -qm 'Verification snapshot' \
    && test -f "$FORGELOOP_DSH_CLI" \
    && npm run candidate --workspace forgeloop-dsh \
    && mkdir -p reports
RUN set -eu; \
    pnpm config set --global store-dir /home/node/verification-pnpm-store; \
    export DSH_HOME=/tmp/verification-prefetch; \
    tarball=$(ls packages/forgeloop/dist/forgeloop-dsh-*.tgz); \
    dsh --profile verification-web --from-default-profile web --dump-config >/dev/null \
    && dsh plugin --profile verification-web add "$PWD/$tarball" \
    && dsh --profile verification-headless --from-default-profile headless --dump-config >/dev/null \
    && dsh plugin --profile verification-headless add "$PWD/$tarball" \
    && rm -rf "$DSH_HOME"

ENV npm_config_offline=true FORGELOOP_VERIFICATION_CONTAINER=1
ENTRYPOINT ["node", "scripts/ts/docker-verify.ts", "--inside"]
