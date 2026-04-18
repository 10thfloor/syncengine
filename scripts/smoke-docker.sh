#!/usr/bin/env bash
# Production smoke test — boot the docker-compose stack, register the
# app's Restate endpoint, hit /?ws=alice and /?ws=bob, assert each
# receives a distinct injected `syncengine-workspace-id` meta tag.
#
# Exits non-zero on any failure. Logs from the `app` container are
# dumped on exit so CI + local runs surface boot errors.

set -euo pipefail

cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_URL="${ADMIN_URL:-http://localhost:9070}"
BUILD="${BUILD:-1}"

log() { printf "▸ %s\n" "$*"; }
fail() { printf "✘ %s\n" "$*" >&2; exit 1; }

cleanup() {
    local rc=$?
    echo "--- app logs ---"
    docker compose logs --tail=200 app || true
    docker compose down -v >/dev/null 2>&1 || true
    exit "$rc"
}
trap cleanup EXIT

if [ "$BUILD" = "1" ]; then
    log "building apps/test/dist"
    pnpm -s build
fi

if [ ! -f apps/test/dist/server/index.mjs ]; then
    fail "apps/test/dist/server/index.mjs missing — run pnpm build first (or set BUILD=1)"
fi

log "docker compose up -d --build"
docker compose up -d --build

log "waiting for app /_ready (90s)"
for i in $(seq 1 90); do
    if curl -sSf "$BASE_URL/_ready" >/dev/null 2>&1; then
        break
    fi
    sleep 1
    if [ "$i" = "90" ]; then fail "app never became ready"; fi
done

log "registering app deployment with restate admin"
# POST is idempotent with force=true — re-running the smoke doesn't
# wedge on "deployment exists" errors from a prior run.
curl -sSf -X POST "$ADMIN_URL/deployments" \
    -H 'content-type: application/json' \
    -d '{"uri":"http://app:9080","force":true}' \
    >/dev/null

extract_ws() {
    local html="$1"
    # Pull the content="..." value from the syncengine-workspace-id meta.
    echo "$html" \
        | grep -oE '<meta name="syncengine-workspace-id" content="[^"]+"' \
        | head -1 \
        | sed -E 's/.*content="([^"]+)"/\1/'
}

log "GET /?ws=alice"
ALICE_HTML=$(curl -sSf "$BASE_URL/?ws=alice")
ALICE_WS=$(extract_ws "$ALICE_HTML")
[ -n "$ALICE_WS" ] || fail "alice response missing syncengine-workspace-id meta tag"

log "GET /?ws=bob"
BOB_HTML=$(curl -sSf "$BASE_URL/?ws=bob")
BOB_WS=$(extract_ws "$BOB_HTML")
[ -n "$BOB_WS" ] || fail "bob response missing syncengine-workspace-id meta tag"

if [ "$ALICE_WS" = "$BOB_WS" ]; then
    fail "expected different wsKey per workspace — got $ALICE_WS for both"
fi

log "GET /?ws=alice again → expect same wsKey as first alice call"
ALICE_HTML_2=$(curl -sSf "$BASE_URL/?ws=alice")
ALICE_WS_2=$(extract_ws "$ALICE_HTML_2")
if [ "$ALICE_WS" != "$ALICE_WS_2" ]; then
    fail "alice wsKey differs between calls: $ALICE_WS vs $ALICE_WS_2"
fi

log "GET /_health"
curl -sSf "$BASE_URL/_health" >/dev/null || fail "/_health did not return 200"

printf "✓ smoke passed (alice=%s bob=%s)\n" "$ALICE_WS" "$BOB_WS"
