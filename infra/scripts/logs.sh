#!/usr/bin/env bash
# Tail logs from all services, or a specific one
# Usage: ./logs.sh [service-name]
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -eq 0 ]; then
  docker compose logs -f --tail=50
else
  docker compose logs -f --tail=50 "$1"
fi
