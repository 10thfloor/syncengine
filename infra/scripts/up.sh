#!/usr/bin/env bash
# Start the full local stack: NATS + Restate + Workspace Service
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ Starting infrastructure..."
docker compose up -d --build

echo ""
echo "▸ Waiting for Restate to be ready..."
until curl -sf http://localhost:9070/health > /dev/null 2>&1; do
  sleep 1
done
echo "  ✓ Restate is healthy"

echo ""
echo "▸ Registering workspace service with Restate..."
curl -sf -X POST http://localhost:9070/deployments \
  -H "Content-Type: application/json" \
  -d '{"uri": "http://workspace-service:9080"}' \
  | jq . 2>/dev/null || echo "  (registration sent)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  NATS        : nats://localhost:4222"
echo "  NATS WS     : ws://localhost:9222"
echo "  NATS Monitor: http://localhost:8222"
echo "  Restate     : http://localhost:8080"
echo "  Restate Admin: http://localhost:9070"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
