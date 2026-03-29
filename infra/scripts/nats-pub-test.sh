#!/usr/bin/env bash
# Publish a test delta to a workspace stream (for debugging)
# Usage: ./nats-pub-test.sh <workspace-id> [message]
set -euo pipefail

WORKSPACE_ID="${1:?Usage: $0 <workspace-id> [message]}"
MESSAGE="${2:-"{\"type\":\"INSERT\",\"table\":\"expenses\",\"record\":{\"id\":\"test-1\",\"amount\":42.00,\"category\":\"Test\"}}"}"

SUBJECT="ws.${WORKSPACE_ID}.deltas"

if command -v nats &> /dev/null; then
  echo "▸ Publishing to ${SUBJECT}..."
  echo "$MESSAGE" | nats pub "$SUBJECT"
  echo "  ✓ Published"
else
  echo "nats CLI not installed. Install via:"
  echo "  brew install nats-io/nats-tools/nats"
  echo ""
  echo "Or use the NATS monitoring endpoint to verify streams:"
  echo "  curl http://localhost:8222/jsz?streams=true | jq ."
fi
