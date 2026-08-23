#!/bin/bash
# scripts/refresh-tunnel.sh — regenerate the cloudflared quick tunnel and
# re-wire every hardcoded reference to its hostname (docker-compose.yml's
# AUTHENTIK_HOST_BROWSER, the tunnel-proxy-provider blueprint, Traefik's
# dynamic.yml). TEMPORARY tooling — see the "TEMPORARY" comments in those
# three files. Run this any time the tunnel has died (check with
# `pgrep -f 'cloudflared tunnel'`) or you just want a fresh URL.
#
# Usage: sudo ./scripts/refresh-tunnel.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FILES=(
  docker-compose.yml
  authentik/blueprints/dashboard-proxy-provider.yaml
  authentik/traefik/dynamic/dynamic.yml
)

OLD_HOST=$(grep -oE '[a-z0-9-]+\.trycloudflare\.com' docker-compose.yml | head -1)
if [ -z "$OLD_HOST" ]; then
  echo "Could not find an existing *.trycloudflare.com hostname in docker-compose.yml — aborting." >&2
  exit 1
fi
echo "Current tunnel hostname: $OLD_HOST"

echo "Stopping any existing cloudflared process..."
pkill -f 'cloudflared tunnel' 2>/dev/null || true
sleep 1

echo "Starting a new quick tunnel..."
LOG=/var/log/cloudflared.log
: > "$LOG"
nohup /usr/local/bin/cloudflared tunnel --url https://localhost:443 --no-tls-verify > "$LOG" 2>&1 &
disown

NEW_HOST=""
for _ in $(seq 1 30); do
  NEW_HOST=$(grep -oE '[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  [ -n "$NEW_HOST" ] && break
  sleep 1
done

if [ -z "$NEW_HOST" ]; then
  echo "Timed out waiting for cloudflared to print a new hostname — check $LOG." >&2
  exit 1
fi
echo "New tunnel hostname: $NEW_HOST"

echo "Rewriting $OLD_HOST -> $NEW_HOST across ${FILES[*]}..."
for f in "${FILES[@]}"; do
  sed -i "s/$OLD_HOST/$NEW_HOST/g" "$f"
done

echo "Recreating authentik-server and authentik-worker to pick up the new hostname..."
docker compose up -d authentik-server authentik-worker

echo "Waiting for authentik-server to report healthy..."
until [ "$(docker inspect asia-authentik-server-1 --format '{{.State.Health.Status}}' 2>/dev/null)" = "healthy" ]; do
  sleep 2
done

echo
echo "Done. New public URL: https://$NEW_HOST"
echo "(Traefik picks up dynamic.yml changes live — no traefik restart needed.)"
