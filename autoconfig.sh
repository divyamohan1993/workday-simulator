#!/usr/bin/env bash
#
# Idempotent zero-intervention deploy for the Workday Simulator.
# Builds the Docker image, runs the container on port 8477, and health-checks it.
# Safe to re-run: it replaces any existing container. All config comes from .env.
#
# Usage:  cp .env.example .env  &&  edit .env (set ADMIN_TOKEN)  &&  ./autoconfig.sh

set -euo pipefail

IMAGE="workday-simulator:latest"
NAME="workday-simulator"
PORT="${PORT:-8477}"
VOLUME="workday-data"

log() { printf '[autoconfig] %s\n' "$*"; }

# --- preconditions -----------------------------------------------------------
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }

if [ ! -f .env ]; then
  echo "No .env found. Copy .env.example to .env and set ADMIN_TOKEN first." >&2
  exit 1
fi

ADMIN_TOKEN_VALUE="$(grep -E '^ADMIN_TOKEN=' .env | head -1 | cut -d= -f2-)"
if [ -z "${ADMIN_TOKEN_VALUE}" ] \
  || [ ${#ADMIN_TOKEN_VALUE} -lt 16 ] \
  || [[ "${ADMIN_TOKEN_VALUE}" == GENERATE_* ]] \
  || [[ "${ADMIN_TOKEN_VALUE}" == change-me* ]]; then
  echo "ADMIN_TOKEN in .env is unset, too short (min 16), or still the placeholder. Fix it." >&2
  exit 1
fi

# --- build -------------------------------------------------------------------
log "Building image ${IMAGE} ..."
docker build -t "${IMAGE}" .

# --- run (idempotent) --------------------------------------------------------
log "Ensuring data volume ${VOLUME} ..."
docker volume inspect "${VOLUME}" >/dev/null 2>&1 || docker volume create "${VOLUME}" >/dev/null

log "Replacing container ${NAME} ..."
docker rm -f "${NAME}" >/dev/null 2>&1 || true
docker run -d \
  --name "${NAME}" \
  --env-file .env \
  -e PORT="${PORT}" \
  -p "${PORT}:${PORT}" \
  -v "${VOLUME}:/app/data" \
  --restart unless-stopped \
  "${IMAGE}" >/dev/null

# --- health check ------------------------------------------------------------
log "Waiting for health on http://127.0.0.1:${PORT}/api/health ..."
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    log "Healthy. Dashboard: http://127.0.0.1:${PORT}/"
    exit 0
  fi
  sleep 2
done

echo "[autoconfig] Health check failed. Recent logs:" >&2
docker logs --tail 50 "${NAME}" >&2 || true
exit 1
