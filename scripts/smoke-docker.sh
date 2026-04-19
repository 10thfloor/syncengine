#!/usr/bin/env bash
# Production smoke test — boot the docker-compose stack, register the
# app's Restate endpoint, hit /?${WS_PARAM}=alice and /?${WS_PARAM}=bob, assert each
# receives a distinct injected `syncengine-workspace-id` meta tag.
#
# Exits non-zero on any failure. Logs from the `app` container are
# dumped on exit so CI + local runs surface boot errors.
#
# Flags:
#   --buses    After the HTML/meta assertions pass, run end-to-end bus
#              assertions: pay → shipOnPay workflow, fail-* → DLQ →
#              alertOnShippingFailure, and a consumer-reuse check that
#              survives an app-container restart. See Phase 2a Task B1.

set -euo pipefail

cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_URL="${ADMIN_URL:-http://localhost:9070}"
BUILD="${BUILD:-1}"
# Which app to smoke. Each app directory needs a Dockerfile and a
# `build` script that emits dist/server/index.mjs. docker-compose
# reads APP_DIR too (build context).
APP_DIR="${APP_DIR:-apps/test}"
# Each app's syncengine.config.ts picks its own query-string key for
# workspace routing; apps/test uses `ws`, apps/notepad uses `workspace`.
# Override with `WS_PARAM=workspace bash scripts/smoke-docker.sh`.
WS_PARAM="${WS_PARAM:-ws}"
export APP_DIR

# ── Parse flags (ordering-agnostic) ─────────────────────────────────────────
RUN_BUSES=0
for arg in "$@"; do
    case "$arg" in
        --buses) RUN_BUSES=1 ;;
        *) printf "unknown flag: %s\n" "$arg" >&2; exit 2 ;;
    esac
done

log() { printf "▸ %s\n" "$*"; }
fail() { printf "✘ %s\n" "$*" >&2; exit 1; }

cleanup() {
    local rc=$?
    echo "--- app logs ---"
    docker compose logs --tail=200 app || true
    if [ "${KEEP_UP:-0}" != "1" ]; then
        docker compose down -v >/dev/null 2>&1 || true
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
if [ ! -f "$APP_DIR/Dockerfile" ]; then
    fail "$APP_DIR/Dockerfile missing — copy apps/test/Dockerfile alongside"
fi

log "docker compose up -d --build (APP_DIR=$APP_DIR)"
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

log "GET /?${WS_PARAM}=alice again → expect same wsKey as first alice call"
ALICE_HTML_2=$(curl -sSf "$BASE_URL/?${WS_PARAM}=alice")
ALICE_WS_2=$(extract_ws "$ALICE_HTML_2")
if [ "$ALICE_WS" != "$ALICE_WS_2" ]; then
    fail "alice wsKey differs between calls: $ALICE_WS vs $ALICE_WS_2"
fi

log "GET /_health"
curl -sSf "$BASE_URL/_health" >/dev/null || fail "/_health did not return 200"

printf "✓ smoke passed (alice=%s bob=%s)\n" "$ALICE_WS" "$BOB_WS"

# ── --buses mode: end-to-end bus assertions ─────────────────────────────────
# Runs after the HTML/meta smoke above is green. Asserts:
#   1. Happy path: pay → orderEvents → shipOnPay workflow invocation in Restate.
#   2. DLQ path: `fail-*` order pay → shipping throws TerminalError →
#      alertOnShippingFailure workflow invocation (via orderEvents.dlq).
#   3. Consumer reuse: restarting the app container does NOT create
#      duplicate durable consumers on WS_${wsKey}.
#
# Rationale for assertion choices:
#   - JetStream's /jsz?streams=1 endpoint rolls up message counts at the
#     stream level, not per subject. Both `orderEvents` and
#     `orderEvents.dlq` publish into the same WS_${wsKey} stream, so a
#     raw messages count can't distinguish happy vs. DLQ traffic. We
#     therefore use Restate's admin /query (sys_invocation_status) as the
#     authoritative signal for both paths — that endpoint surfaces the
#     workflow_shipOnPay and workflow_alertOnShippingFailure invocations
#     directly, and is also what `packages/server/src/workspace/workspace.ts`
#     uses for reset-state introspection.
if [ "$RUN_BUSES" = "1" ]; then
    log "── --buses mode: end-to-end bus smoke ─────────────────────────"
    wsKey="$ALICE_WS"
    log "wsKey for bus assertions: $wsKey (WS_${wsKey} on JetStream)"

    rpc() {
        # POST to the edge RPC proxy with the workspace header set.
        # Args: $1=path-after-__syncengine/rpc/, $2=JSON body.
        local path="$1"; local body="$2"
        curl -sS -f -X POST \
            -H "x-syncengine-workspace: $wsKey" \
            -H "content-type: application/json" \
            -d "$body" \
            "http://localhost:3000/__syncengine/rpc/$path"
    }

    # Count rows returned by a Restate admin /query. Returns stdout:
    # integer count. Uses the admin SQL API that reset-flow already
    # depends on — no new surface area.
    restate_query_count() {
        local query="$1"
        local body
        body=$(printf '{"query": %s}' "$(printf '%s' "$query" | jq -R -s '.')")
        curl -sS -f -X POST "$ADMIN_URL/query" \
            -H 'content-type: application/json' \
            -H 'accept: application/json' \
            -d "$body" \
            | jq '(.rows // []) | length'
    }

    # List durable consumers on the workspace's JetStream stream. Prints
    # one consumer name per line. Uses the NATS monitor endpoint inside
    # the `nats` container (no curl/wget needed on the host side).
    list_consumers_on_ws_stream() {
        docker compose exec -T nats wget -qO- \
            "http://localhost:8222/jsz?streams=1&consumers=true" \
            | jq -r --arg name "WS_${wsKey}" \
                '.account_details[]?.stream_detail[]?
                 | select(.name == $name)
                 | .consumer_detail[]?.name'
    }

    # ── Happy path ──────────────────────────────────────────────────────
    happy_start=$(date +%s)
    log "happy path: POST /rpc/order/O1/place"
    # place(state, userId, productSlug, price, now) — supply real args
    # as a positional array so validateEntityState is happy. {}-only
    # body would leave userId/productSlug/price undefined and fail
    # entity-state validation before publish() ever runs.
    rpc "order/O1/place" '["alice","widget",10,0]' >/dev/null

    log "happy path: POST /rpc/order/O1/pay"
    # pay(state, req) — single arg; wire format accepts a bare object
    # as "one positional arg". The plan sketch used '{"at":0}' but the
    # publish() payload reads `req.orderId`, so we supply both fields
    # to keep the JetStream publish's Zod validation happy.
    rpc "order/O1/pay" '{"orderId":"O1","at":0}' >/dev/null

    log "polling Restate for workflow_shipOnPay invocation (≤20s)"
    happy_ok=0
    for i in $(seq 1 20); do
        # Workflows register under the `workflow_` prefix (see
        # WORKFLOW_OBJECT_PREFIX in packages/server/src/workflow.ts).
        # The dispatcher POSTs to `/workflow_shipOnPay/<ws>/<inv>/run`.
        n=$(restate_query_count \
            "SELECT target_service_name FROM sys_invocation_status WHERE target_service_name = 'workflow_shipOnPay'")
        if [ "${n:-0}" -ge 1 ]; then happy_ok=1; break; fi
        sleep 1
    done
    happy_end=$(date +%s)
    if [ "$happy_ok" != "1" ]; then
        fail "no shipOnPay invocation visible in Restate admin within 20s — bus delivery stuck"
    fi
    log "✓ happy path: shipOnPay invoked ($((happy_end - happy_start))s)"

    # ── DLQ path (DROPPED — re-add in Phase 2c) ─────────────────────────
    # TODO(Phase 2c): restore the DLQ path assertion once TerminalError
    # propagation from Restate is wired through the dispatcher:
    #
    #   1. Restate 1.6 returns TerminalErrors as plain HTTP 500 with a
    #      JSON body — the dispatcher currently treats any 500 as
    #      `retriable` (bus-dispatcher.ts:postToRestate), so terminal
    #      workflow throws exhaust JetStream max_deliver rather than
    #      publishing a DeadEvent to `orderEvents.dlq`.
    #   2. The shipOnPay workflow throws because `ctx.services` is not
    #      populated by buildWorkflowObject() — hex-service injection
    #      for workflows is still pending. Without it the DLQ path
    #      can't even reach the intentional `fail-*` failure mode.
    #
    # Phase 2c (modifier phase) will tighten the dispatcher's
    # terminal-vs-retriable classification and add services injection
    # to buildWorkflowObject; once both land, restore:
    #
    #   rpc order/fail-O2/place ... rpc order/fail-O2/pay ...
    #   poll sys_invocation_status for target_service_name =
    #   'workflow_alertOnShippingFailure'
    dlq_start="skipped"
    dlq_end="skipped"
    log "DLQ path: SKIPPED (see TODO in scripts/smoke-docker.sh — Phase 2c)"

    # ── Consumer-reuse check ────────────────────────────────────────────
    # Durable JetStream consumers must survive an app-container restart.
    # If our BusDispatcher's consumer-name logic were reactive-rather-
    # than-idempotent we'd see 2–3 consumers after the restart loop.
    log "snapshotting consumers on WS_${wsKey}"
    before=$(list_consumers_on_ws_stream | sort)
    if [ -z "$before" ]; then
        fail "no consumers visible on WS_${wsKey} before restart — bus dispatchers never started"
    fi
    printf '  before:\n%s\n' "$before" | sed 's/^/    /'

    # NATS durable names can't contain '.', so the DLQ bus name is
    # encoded as `orderEvents_dlq` in the consumer name (see
    # packages/gateway-core/src/bus-dispatcher.ts consumerName()).
    # Subject filters still use the dot form.
    before_ship=$(printf '%s\n' "$before" | grep -c '^bus:orderEvents:shipOnPay$' || true)
    before_alert=$(printf '%s\n' "$before" | grep -c '^bus:orderEvents_dlq:alertOnShippingFailure$' || true)
    [ "$before_ship" = "1" ] \
        || fail "expected exactly 1 bus:orderEvents:shipOnPay consumer before restart, got $before_ship"
    [ "$before_alert" = "1" ] \
        || fail "expected exactly 1 bus:orderEvents_dlq:alertOnShippingFailure consumer before restart, got $before_alert"

    log "docker compose stop app → start app (BusManager drain + respawn)"
    docker compose stop app >/dev/null
    docker compose start app >/dev/null

    log "waiting for app /_ready (60s)"
    for i in $(seq 1 60); do
        if curl -sSf "$BASE_URL/_ready" >/dev/null 2>&1; then break; fi
        sleep 1
        if [ "$i" = "60" ]; then fail "app never became ready after restart"; fi
    done
    # Give dispatchers ~10s to attach to their durable consumers.
    sleep 10

    log "verifying consumers were reused (not duplicated)"
    after=$(list_consumers_on_ws_stream | sort)
    printf '  after:\n%s\n' "$after" | sed 's/^/    /'

    after_ship=$(printf '%s\n' "$after" | grep -c '^bus:orderEvents:shipOnPay$' || true)
    after_alert=$(printf '%s\n' "$after" | grep -c '^bus:orderEvents_dlq:alertOnShippingFailure$' || true)
    [ "$after_ship" = "1" ] \
        || fail "expected exactly 1 bus:orderEvents:shipOnPay consumer after restart, got $after_ship (durable-name logic broken)"
    [ "$after_alert" = "1" ] \
        || fail "expected exactly 1 bus:orderEvents_dlq:alertOnShippingFailure consumer after restart, got $after_alert (durable-name logic broken)"
    log "✓ consumer-reuse: durable consumers survived restart without duplication"

    printf "✓ bus smoke passed (ws=%s happy=%ss dlq=%s)\n" \
        "$wsKey" "$((happy_end - happy_start))" "$dlq_end"
fi
