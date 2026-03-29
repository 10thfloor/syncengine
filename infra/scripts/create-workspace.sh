#!/usr/bin/env bash
# Create a new workspace via the Restate workspace service
# Usage: ./create-workspace.sh <workspace-id> [tenant-id]
set -euo pipefail

WORKSPACE_ID="${1:?Usage: $0 <workspace-id> [tenant-id]}"
TENANT_ID="${2:-default}"
RESTATE_URL="${RESTATE_URL:-http://localhost:8080}"

echo "▸ Provisioning workspace: ${WORKSPACE_ID} (tenant: ${TENANT_ID})..."

RESPONSE=$(curl -sf -X POST \
  "${RESTATE_URL}/workspace/${WORKSPACE_ID}/provision" \
  -H "Content-Type: application/json" \
  -d "{\"tenantId\": \"${TENANT_ID}\"}")

echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"

echo ""
echo "  ✓ Workspace ready"
echo "  Stream  : WS_${WORKSPACE_ID//-/_}"
echo "  Subject : ws.${WORKSPACE_ID}.>"
echo "  Schema  : v$(echo "$RESPONSE" | jq -r '.schemaVersion' 2>/dev/null || echo '1')"
