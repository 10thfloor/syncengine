#!/usr/bin/env bash
# Scale-out smoke test — boots the two-tier stack (edge Bun binary +
# Node handlers + nats + restate), registers the handlers with Restate
# admin, then asserts the edge injects distinct wsKey meta tags per
# workspace (same assertions as smoke-docker.sh, but against the
# edge topology instead of the single-process one).
#
# Environment:
#   APP_DIR=apps/notepad         which app to build + bundle
#   WS_PARAM=workspace           query-string key for workspace routing
#   BUILD=1                      run `syncengine build` first (default)
#   KEEP_UP=1                    leave the stack up after asserts

set -euo pipefail

cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_URL="${ADMIN_URL:-http://localhost:9070}"
BUILD="${BUILD:-1}"
APP_DIR="${APP_DIR:-apps/test}"
WS_PARAM="${WS_PARAM:-ws}"
export APP_DIR

COMPOSE_FILE="docker-compose.serve.yml"

log() { printf "▸ %s\n" "$*"; }
fail() { printf "✘ %s\n" "$*" >&2; exit 1; }

cleanup() {
    local rc=$?
    echo "--- edge logs ---"
    docker compose -f "$COMPOSE_FILE" logs --tail=60 edge || true
    echo "--- handlers logs ---"
    docker compose -f "$COMPOSE_FILE" logs --tail=60 handlers || true
    if [ "${KEEP_UP:-0}" != "1" ]; then
        docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
    else
        printf "\n▸ stack left running (KEEP_UP=1). Open %s/?%s=alice\n" "$BASE_URL" "$WS_PARAM"
    fi
    exit "$rc"
}
trap cleanup EXIT

if [ "$BUILD" = "1" ]; then
    log "building $APP_DIR/dist"
    ( cd "$APP_DIR" && pnpm exec syncengine build )
fi

if [ ! -f "$APP_DIR/dist/server/index.mjs" ]; then
    fail "$APP_DIR/dist/server/index.mjs missing — run syncengine build first (or set BUILD=1)"
fi
if [ ! -f "$APP_DIR/Dockerfile.handlers" ]; then
    fail "$APP_DIR/Dockerfile.handlers missing — copy apps/test/Dockerfile.handlers alongside"
fi

log "docker compose up -d --build (APP_DIR=$APP_DIR)"
docker compose -f "$COMPOSE_FILE" up -d --build

log "waiting for edge /_ready (120s)"
for i in $(seq 1 120); do
    if curl -sSf "$BASE_URL/_ready" >/dev/null 2>&1; then
        break
    fi
    sleep 1
    if [ "$i" = "120" ]; then fail "edge never became ready"; fi
done

log "registering handlers deployment with restate admin"
curl -sSf -X POST "$ADMIN_URL/deployments" \
    -H 'content-type: application/json' \
    -d '{"uri":"http://handlers:9080","force":true}' \
    >/dev/null

extract_ws() {
    local html="$1"
    echo "$html" \
        | grep -oE '<meta name="syncengine-workspace-id" content="[^"]+"' \
        | head -1 \
        | sed -E 's/.*content="([^"]+)"/\1/'
}

log "GET /?${WS_PARAM}=alice"
ALICE_HTML=$(curl -sSf "$BASE_URL/?${WS_PARAM}=alice")
ALICE_WS=$(extract_ws "$ALICE_HTML")
[ -n "$ALICE_WS" ] || fail "alice response missing syncengine-workspace-id meta tag"

log "GET /?${WS_PARAM}=bob"
BOB_HTML=$(curl -sSf "$BASE_URL/?${WS_PARAM}=bob")
BOB_WS=$(extract_ws "$BOB_HTML")
[ -n "$BOB_WS" ] || fail "bob response missing syncengine-workspace-id meta tag"

if [ "$ALICE_WS" = "$BOB_WS" ]; then
    fail "expected different wsKey per workspace — got $ALICE_WS for both"
fi

log "GET /?${WS_PARAM}=alice again → expect same wsKey (cache hit)"
ALICE_WS_2=$(extract_ws "$(curl -sSf "$BASE_URL/?${WS_PARAM}=alice")")
if [ "$ALICE_WS" != "$ALICE_WS_2" ]; then
    fail "alice wsKey differs between calls: $ALICE_WS vs $ALICE_WS_2"
fi

log "GET /_health"
curl -sSf "$BASE_URL/_health" >/dev/null || fail "/_health did not return 200"

printf "✓ serve smoke passed (alice=%s bob=%s)\n" "$ALICE_WS" "$BOB_WS"
