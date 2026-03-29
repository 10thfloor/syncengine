#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Reset a workspace: purge JetStream stream + clear Restate state + re-provision.
# This gives you a clean slate without tearing down the entire infra.
#
# What it does:
#   1. Purges all messages from the workspace's JetStream stream
#   2. Tears down the Restate virtual object (clears snapshots, peers, authority seqs)
#   3. Re-provisions the workspace with a fresh stream
#
# After running this, hard-refresh the browser (Cmd+Shift+R) to clear OPFS.
# Or paste in the browser console:
#   const r = await navigator.storage.getDirectory();
#   for await (const n of r.keys()) await r.removeEntry(n, {recursive:true});
#   location.reload();
#
# Usage: ./reset-workspace.sh [workspace-id] [tenant-id]
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

WORKSPACE_ID="${1:-demo}"
TENANT_ID="${2:-default}"
RESTATE_URL="${RESTATE_URL:-http://localhost:8080}"
NATS_MONITORING="${NATS_MONITORING:-http://localhost:8222}"

STREAM="WS_${WORKSPACE_ID//-/_}"

echo "▸ Resetting workspace: ${WORKSPACE_ID}"
echo "  Stream  : ${STREAM}"
echo "  Restate : ${RESTATE_URL}"
echo ""

# ── Step 1: Purge JetStream stream ──────────────────────────────────────────
echo "  [1/3] Purging JetStream stream..."

if command -v nats &> /dev/null; then
    nats stream purge "$STREAM" -f 2>/dev/null && echo "        ✓ Stream purged via nats CLI" \
        || echo "        ⚠ Stream not found (may not exist yet)"
else
    # Fall back to NATS monitoring API
    # The monitoring endpoint is read-only, so we go through Restate's triggerGC
    # which calls jsm.streams.purge. For a full purge we teardown + re-provision.
    echo "        (nats CLI not found, will teardown + re-provision instead)"
fi

# ── Step 2: Teardown Restate state ──────────────────────────────────────────
echo "  [2/3] Tearing down Restate state..."

TEARDOWN=$(curl -sf -X POST \
    "${RESTATE_URL}/workspace/${WORKSPACE_ID}/teardown" \
    -H "Content-Type: application/json" \
    -d '{}' 2>/dev/null) \
    && echo "        ✓ Restate state cleared" \
    || echo "        ⚠ Teardown failed (workspace may not exist yet)"

# ── Step 3: Re-provision ────────────────────────────────────────────────────
echo "  [3/3] Re-provisioning workspace..."

PROVISION=$(curl -sf -X POST \
    "${RESTATE_URL}/workspace/${WORKSPACE_ID}/provision" \
    -H "Content-Type: application/json" \
    -d "{\"tenantId\": \"${TENANT_ID}\"}" 2>/dev/null)

if [ $? -eq 0 ]; then
    echo "        ✓ Workspace re-provisioned"
    echo "$PROVISION" | jq . 2>/dev/null || echo "        $PROVISION"
else
    echo "        ✗ Provision failed — is Restate running?"
    echo "          Try: cd infra && ./scripts/up.sh"
    exit 1
fi

echo ""
echo "  ✓ Server-side reset complete."
echo ""
echo "  To clear browser state, hard-refresh (Cmd+Shift+R) or run in console:"
echo '    const r=await navigator.storage.getDirectory();for await(const n of r.keys())await r.removeEntry(n,{recursive:true});location.reload()'
