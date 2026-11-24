#!/usr/bin/env bash
# Runs ON the Sprite, from the repo directory. Builds Captain, makes its identity
# key, and (once the config is filled in) installs it as a Sprite service so it
# starts on boot, restarts on crash, and receives the Sprite URL's traffic.
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
export CAPTAIN_HOME="${CAPTAIN_HOME:-$HOME/.captain}"
AGENT_ID="${1:-banquet-captain}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
need node
need npm

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node $NODE_MAJOR found; Captain needs Node 22 or newer." >&2
  exit 1
fi

echo "== build"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
npm run build
npm test

echo "== identity and config"
node dist/src/cli.js init "$AGENT_ID"

if grep -q REPLACE_ "$CAPTAIN_HOME/config.json"; then
  cat <<EOF

Config still has placeholders: $CAPTAIN_HOME/config.json
  1. Inside this Sprite, list your connectors and copy the hub connector's gateway_base_url:
       curl -s https://api.sprites.dev/v1/gateway/list
  2. Put it in hubGatewayUrl, then run this script again.
The service is not installed until the config is complete.
EOF
  exit 0
fi

echo "== doctor"
node dist/src/cli.js doctor

echo "== service"
if ! command -v sprite-env >/dev/null 2>&1; then
  echo "sprite-env not found; start it by hand with: CAPTAIN_HOME=$CAPTAIN_HOME node $APP_DIR/dist/src/cli.js serve" >&2
  exit 1
fi
if sprite-env services get captain >/dev/null 2>&1; then
  sprite-env services restart captain
else
  sprite-env services create captain \
    --cmd node \
    --args "$APP_DIR/dist/src/cli.js,serve" \
    --dir "$APP_DIR" \
    --env "CAPTAIN_HOME=$CAPTAIN_HOME" \
    --http-port 8080
fi
sprite-env services get captain
echo "Logs: /.sprite/logs/services/captain.log"
