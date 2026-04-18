# Production image for apps/test.
#
# Assumes `syncengine build` has already run on the host (or in a
# separate build stage) — this image only packages the resulting
# `dist/` and the Node runtime. Mirrors spec §9a's "build → package"
# model. The bundled dist/server/index.mjs starts both the Restate
# H2C endpoint (:9080) and the HTTP server (:3000) in-process.
#
# Canonical reference for the single-process Dockerfile. `syncengine init`
# inlines an equivalent copy in packages/cli/src/init.ts — keep them in
# sync (and same for Dockerfile.handlers / .dockerignore).

FROM node:22-bookworm-slim
WORKDIR /app

# `node:*-bookworm-slim` ships a `node` user (uid/gid 1000). Reuse it
# rather than minting our own so the COPY layer and runtime match.
COPY --chown=node:node dist/ ./dist/
USER node

ENV HTTP_PORT=3000 \
    PORT=9080

EXPOSE 3000 9080

# Self-contained liveness probe — works with any orchestrator, not
# just our docker-compose. Uses Node's built-in fetch (≥18) so we
# don't need curl/wget in the slim image.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.HTTP_PORT+'/_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.mjs"]
