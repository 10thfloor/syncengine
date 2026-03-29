#!/usr/bin/env bash
# Tear down a workspace (deletes JetStream stream + marks deleted)
# Usage: ./delete-workspace.sh <workspace-id>
set -euo pipefail

WORKSPACE_ID="${1:?Usage: $0 <workspace-id>}"
RESTATE_URL="${RESTATE_URL:-http://localhost:8080}"

echo "▸ Tearing down workspace: ${WORKSPACE_ID}..."

RESPONSE=$(curl -sf -X POST \
  "${RESTATE_URL}/workspace/${WORKSPACE_ID}/teardown" \
  -H "Content-Type: application/json" \
  -d '{}')

echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
echo "  ✓ Workspace deleted"
