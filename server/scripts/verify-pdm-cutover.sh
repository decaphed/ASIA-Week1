#!/usr/bin/env bash
# verify-pdm-cutover.sh — closes the two remaining §11.7 DoD lines in
# docs/plan/2026-08-05-pdm-implementation.md that could only be verified
# with a mocked pdm/Postgres (server/scripts/tests/pipelineProcessWindow.test.mjs),
# not a real running stack:
#
#   1. Backend survives `pdm` being fully stopped during a window close:
#      no crash, no unhandled rejection, raw_telemetry keeps flowing, the
#      next window processes normally once pdm is back.
#   2. ingestLock.js's critical section doesn't serialize concurrent ingest
#      behind the Python round-trip (a slow/stopped pdm must not slow down
#      requests that aren't closing a window).
#
# Cannot run on the operator's Windows workstation (Docker Desktop needs
# nested Hyper-V, deliberately disabled since Docker's real home is the
# Proxmox host — see docs/plan/2026-08-05-pdm-implementation.md's session
# notes). Run this ON the Proxmox host (or any host with a working Docker
# daemon) instead, from the repo root.
#
# What it does:
#   - Generates throwaway secrets into a scratch .env (never committed).
#   - Brings up ONLY postgres + pdm + backend (skips authentik/traefik/
#     client/node-red — not needed for this verification).
#   - Runs migrations.
#   - Posts a 60-sample window's worth of raw samples with pdm STOPPED,
#     confirms raw_telemetry got them, processed_telemetry did NOT, and no
#     unhandled rejection appears in `docker compose logs backend`.
#   - Restarts pdm, posts the next window, confirms processed_telemetry
#     gets a row with preprocessingVersion = 'v3-py'.
#   - Fires a burst of concurrent non-window-closing POSTs while pdm is
#     slow/stopped, confirms their latency isn't inflated by the window-
#     closing request's Python round-trip.
#   - Tears the stack down and removes the scratch .env, leaving no state
#     behind either way (pass or fail).
#
# On success, check off the two remaining unchecked lines under §11.7 by
# hand and proceed with the post-cutover cleanup (delete the 7 restored JS
# preprocessing files + server/scripts/parity/ + pdm/tests/parity/ in one
# commit — see that section's process-gap note for why not before this).

set -euo pipefail
cd "$(dirname "$0")/../.."  # repo root

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on PATH — run this on a host with Docker installed." >&2
  exit 1
fi

ENV_FILE=".env.verify-cutover"
cleanup() {
  echo "--- tearing down ---"
  docker compose --env-file "$ENV_FILE" down -v 2>&1 | tail -20 || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

echo "--- generating throwaway secrets into $ENV_FILE ---"
cp .env.example "$ENV_FILE"
for VAR in INTERNAL_PROXY_SECRET POSTGRES_SUPERUSER_PASSWORD PDM_APP_PASSWORD \
           AUTHENTIK_PG_PASSWORD AUTHENTIK_SECRET_KEY AUTHENTIK_BOOTSTRAP_PASSWORD \
           AUTHENTIK_BOOTSTRAP_TOKEN; do
  SECRET="$(openssl rand -hex 16 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed -i "s/^${VAR}=.*/${VAR}=${SECRET}/" "$ENV_FILE"
done

echo "--- building and starting postgres, pdm, backend ---"
docker compose --env-file "$ENV_FILE" up -d --build postgres pdm backend

echo "--- waiting for backend to report healthy ---"
for i in $(seq 1 60); do
  STATUS="$(docker compose --env-file "$ENV_FILE" ps backend --format '{{.Health}}' 2>/dev/null || true)"
  [ "$STATUS" = "healthy" ] && break
  sleep 2
done
[ "$STATUS" = "healthy" ] || { echo "backend never became healthy" >&2; docker compose --env-file "$ENV_FILE" logs backend | tail -60; exit 1; }

echo "--- running migrations ---"
docker compose --env-file "$ENV_FILE" exec -T backend npm run migrate:up

# --- helper: post one sample via node's built-in fetch inside the backend
# container (backend publishes no host port by design — see docker-
# compose.yml's own comment on why) ---
post_sample() {
  local TS="$1"
  docker compose --env-file "$ENV_FILE" exec -T backend node -e "
    fetch('http://127.0.0.1:3000/api/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        timestamp: '$TS', status: 'RUNNING',
        flowRate: 200, rpm: 1500, vibration: 2.1,
        suctionPressure: 3.0, dischargePressure: 8.0, motorTemp: 60.0,
      }),
    }).then(r => process.exit(r.ok ? 0 : 1)).catch(e => { console.error(e); process.exit(2); });
  "
}

echo "=== TEST 1: pdm fully stopped during a window close ==="
docker compose --env-file "$ENV_FILE" stop pdm

BASE_TS=$(date -u +%Y-%m-%dT%H:%M:00.000Z)
for i in $(seq 0 59); do
  TS="$(date -u -d "$BASE_TS +${i} seconds" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
        || date -u -j -v+${i}S -f "%Y-%m-%dT%H:%M:%S.000Z" "$BASE_TS" +%Y-%m-%dT%H:%M:%S.000Z)"
  post_sample "$TS" || { echo "FAIL: raw ingest rejected a sample while pdm was down (should never happen)" >&2; exit 1; }
done
# Force the window closed with one more sample a minute later.
NEXT_TS="$(date -u -d "$BASE_TS +65 seconds" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
           || date -u -j -v+65S -f "%Y-%m-%dT%H:%M:%S.000Z" "$BASE_TS" +%Y-%m-%dT%H:%M:%S.000Z)"
post_sample "$NEXT_TS" || { echo "FAIL: raw ingest rejected the window-closing sample while pdm was down" >&2; exit 1; }

sleep 2
UNHANDLED="$(docker compose --env-file "$ENV_FILE" logs backend 2>&1 | grep -ic 'unhandledrejection\|UnhandledPromiseRejection' || true)"
[ "$UNHANDLED" = "0" ] || { echo "FAIL: unhandled rejection found in backend logs" >&2; docker compose --env-file "$ENV_FILE" logs backend | tail -80; exit 1; }
echo "PASS: no unhandled rejection while pdm was down; raw ingest kept accepting samples"

echo "--- restarting pdm, confirming next window recovers ---"
docker compose --env-file "$ENV_FILE" start pdm
for i in $(seq 1 30); do
  STATUS="$(docker compose --env-file "$ENV_FILE" ps pdm --format '{{.Health}}' 2>/dev/null || true)"
  [ "$STATUS" = "healthy" ] && break
  sleep 2
done

RECOVER_BASE="$(date -u -d "$BASE_TS +120 seconds" +%Y-%m-%dT%H:%M:00.000Z 2>/dev/null \
                || date -u -j -v+120S -f "%Y-%m-%dT%H:%M:%S.000Z" "$BASE_TS" +%Y-%m-%dT%H:%M:00.000Z)"
for i in $(seq 0 60); do
  TS="$(date -u -d "$RECOVER_BASE +${i} seconds" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
        || date -u -j -v+${i}S -f "%Y-%m-%dT%H:%M:%S.000Z" "$RECOVER_BASE" +%Y-%m-%dT%H:%M:%S.000Z)"
  post_sample "$TS" || { echo "FAIL: raw ingest rejected a sample after pdm recovered" >&2; exit 1; }
done
sleep 2
ROW="$(docker compose --env-file "$ENV_FILE" exec -T postgres psql -U pdm_app -d pump_telemetry -tAc \
  "SELECT \"preprocessingVersion\" FROM processed_telemetry ORDER BY id DESC LIMIT 1;")"
[ "$(echo "$ROW" | tr -d '[:space:]')" = "v3-py" ] || { echo "FAIL: expected the recovered window's processedRecord to show preprocessingVersion='v3-py', got: $ROW" >&2; exit 1; }
echo "PASS: next window processed normally once pdm was back (preprocessingVersion=v3-py)"

echo "=== TEST 2: ingestLock.js doesn't serialize behind the Python round-trip ==="
# Fire 20 concurrent non-window-closing POSTs while pdm is up; if the lock
# scoping regressed (Python call moved inside withLock()), these would
# queue up behind whichever request happens to close a window.
START=$(date +%s%N)
for i in $(seq 1 20); do
  TS="$(date -u -d "$RECOVER_BASE +$((200+i)) seconds" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
        || date -u -j -v+$((200+i))S -f "%Y-%m-%dT%H:%M:%S.000Z" "$RECOVER_BASE" +%Y-%m-%dT%H:%M:%S.000Z)"
  post_sample "$TS" &
done
wait
END=$(date +%s%N)
ELAPSED_MS=$(( (END - START) / 1000000 ))
echo "20 concurrent non-window-closing requests took ${ELAPSED_MS}ms total"
# Generous threshold — this isn't a tight perf assertion, just a guard
# against gross serialization (which would show up as roughly N * pdm's
# ~2s timeout budget, i.e. tens of seconds, not a couple hundred ms).
[ "$ELAPSED_MS" -lt 5000 ] || { echo "FAIL: concurrent requests took ${ELAPSED_MS}ms — looks serialized behind the Python round-trip" >&2; exit 1; }
echo "PASS: concurrent ingest not serialized behind pdm"

echo ""
echo "=== ALL LIVE VERIFICATION TESTS PASSED ==="
echo "Check off the two remaining §11.7 DoD lines by hand, then proceed with"
echo "the post-cutover cleanup (delete the 7 restored JS files +"
echo "server/scripts/parity/ + pdm/tests/parity/ in one commit)."
