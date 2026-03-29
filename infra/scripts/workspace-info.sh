#!/usr/bin/env bash
# Get workspace state from Restate
# Usage: ./workspace-info.sh <workspace-id>
set -euo pipefail

WORKSPACE_ID="${1:?Usage: $0 <workspace-id>}"
RESTATE_URL="${RESTATE_URL:-http://localhost:8080}"

echo "▸ Workspace: ${WORKSPACE_ID}"
echo ""

# Restate state
RESPONSE=$(curl -sf -X POST \
  "${RESTATE_URL}/workspace/${WORKSPACE_ID}/getState" \
  -H "Content-Type: application/json" \
  -d '{}')

echo "Restate state:"
echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"

# NATS stream info (if nats CLI is available)
STREAM="WS_${WORKSPACE_ID//-/_}"
if command -v nats &> /dev/null; then
  echo ""
  echo "NATS stream (${STREAM}):"
  nats stream info "$STREAM" 2>/dev/null || echo "  (stream not found or nats CLI not connected)"
else
  echo ""
  echo "NATS stream info:"
  curl -sf "http://localhost:8222/jsz?streams=true" \
    | jq ".account_details[].stream_detail[] | select(.name == \"${STREAM}\")" 2>/dev/null \
    || echo "  (install nats CLI for detailed stream info)"
fi
