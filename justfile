# syncengine development & production recipes
# Usage: just <recipe>

root := justfile_directory()
app := root / "apps/notepad"
tsx := root / "node_modules/.pnpm/node_modules/.bin/tsx"
cli := tsx + " " + root / "packages/cli/src/index.ts"

# Ports used by the syncengine dev stack
nats_ports := "4222,9222,8222"
restate_ports := "8080,9070,5122"
se_ports := "9080,9333"
all_ports := nats_ports + "," + restate_ports + "," + se_ports

# ── Nuke — the reliable cleanup ─────────────────────────────────────────

# Kill everything syncengine-related: by port, process name, and Docker containers
[group('cleanup')]
nuke:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Killing by port ({{all_ports}})..."
    lsof -ti :{{all_ports}} 2>/dev/null | xargs kill -9 2>/dev/null || true
    echo "Killing by process name..."
    pkill -9 -f "nats-server" 2>/dev/null || true
    pkill -9 -f "restate-server" 2>/dev/null || true
    pkill -9 -f "syncengine dev" 2>/dev/null || true
    pkill -9 -f "syncengine start" 2>/dev/null || true
    echo "Stopping Docker containers..."
    docker ps -q --filter "name=syncengine-" 2>/dev/null | xargs docker stop 2>/dev/null || true
    echo "Cleaning state files..."
    rm -f "{{app}}/.syncengine/dev/pids.json" "{{app}}/.syncengine/dev/runtime.json" 2>/dev/null || true
    echo "Done. All ports free."

# ── Dev stack (NATS + Restate + gateway + Vite) ─────────────────────────

# Start the full dev stack (NATS, Restate, gateway, workspace, Vite)
[group('dev')]
dev-up: nuke
    cd {{app}} && {{cli}} dev

# Tear down the dev stack (tries graceful first, then nukes)
[group('dev')]
dev-down:
    cd {{app}} && {{cli}} down || just nuke

# ── Prod-like local run (build + infra + serve) ─────────────────────────

# Build the app, start NATS + Restate, then serve the production bundle
[group('prod')]
prod-up: nuke
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{app}}"
    echo "▸ building..."
    {{cli}} build
    echo "▸ resolving binaries..."
    nats_bin=$({{tsx}} -e "import{binaryPath}from'@syncengine/nats-bin';binaryPath().then(p=>console.log(p))")
    restate_bin=$({{tsx}} -e "import{binaryPath}from'@syncengine/restate-bin';binaryPath().then(p=>console.log(p))")
    # Write NATS config (websocket requires a config file, not CLI flags)
    state_dir="{{app}}/.syncengine/prod"
    mkdir -p "$state_dir/jetstream"
    cat > "$state_dir/nats-server.conf" <<NATS
    listen: 0.0.0.0:4222
    http_port: 8222
    server_name: syncengine_prod
    websocket { listen: "0.0.0.0:9222"; no_tls: true }
    jetstream { store_dir: "$state_dir/jetstream"; max_mem: 256MB; max_file: 1GB }
    NATS
    echo "▸ starting nats-server..."
    "$nats_bin" -c "$state_dir/nats-server.conf" &
    echo "▸ starting restate-server..."
    RESTATE_LOG_FILTER="warn,restate=info" \
    RESTATE_AUTO_PROVISION="true" \
    RESTATE_CLUSTER_NAME="syncengine-prod" \
      "$restate_bin" --base-dir "$state_dir/restate" --node-name syncengine-prod &
    # Wait for Restate admin to be ready
    echo "▸ waiting for restate admin..."
    for i in $(seq 1 20); do
      curl -sf http://127.0.0.1:9070/health >/dev/null 2>&1 && break
      sleep 0.5
    done
    # Start the production server (Restate endpoint + HTTP) in background,
    # then register the deployment with Restate admin so it knows about our services
    echo "▸ starting production server..."
    {{cli}} start &
    SERVER_PID=$!
    sleep 2
    echo "▸ registering deployment with restate admin..."
    curl -sf -X POST http://127.0.0.1:9070/deployments \
      -H 'content-type: application/json' \
      -d '{"uri":"http://127.0.0.1:9080","force":true}' >/dev/null
    echo "▸ ready — http://localhost:3000"
    wait $SERVER_PID

# Tear down the prod stack
[group('prod')]
prod-down:
    cd {{app}} && {{cli}} down || just nuke

# ── Notepad app ─────────────────────────────────────────────────────────

# Run notepad in dev mode (full stack: NATS + Restate + gateway + Vite + HMR)
[group('app')]
notepad-dev: nuke
    cd {{app}} && {{cli}} dev

# Build and run notepad in production mode (alias for prod-up)
[group('app')]
notepad-prod: prod-up
