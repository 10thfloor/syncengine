#!/usr/bin/env bash
# Stop and remove all containers + volumes
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ Stopping infrastructure..."
docker compose down -v
echo "  ✓ All containers stopped, volumes removed"
