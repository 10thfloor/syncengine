# Production image for apps/notepad.
#
# Assumes `syncengine build` has already run on the host (or in a
# separate build stage) — this image only packages the resulting
# `dist/` and the Node runtime. Mirrors spec §9a's "build → package"
# model. The bundled dist/server/index.mjs starts both the Restate
# H2C endpoint (:9080) and the HTTP server (:3000) in-process.

FROM node:22-bookworm-slim
WORKDIR /app

COPY dist/ ./dist/

ENV HTTP_PORT=3000 \
    PORT=9080

EXPOSE 3000 9080

CMD ["node", "dist/server/index.mjs"]
