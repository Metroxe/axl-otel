#!/usr/bin/env bash
set -euo pipefail

CONFIG="${AXL_CONFIG:-/etc/axl/node-config.json}"

if [[ ! -f "${CONFIG}" ]]; then
  echo "entrypoint: no AXL config at ${CONFIG}" >&2
  exit 1
fi

cd "$(dirname "${CONFIG}")"
axl-node -config "${CONFIG}" &
AXL_PID=$!

cd /app
bun run src/index.ts &
APP_PID=$!

shutdown() {
  kill -TERM "${AXL_PID}" "${APP_PID}" 2>/dev/null || true
}
trap shutdown INT TERM

wait -n "${AXL_PID}" "${APP_PID}"
EXIT=$?
shutdown
wait || true
exit "${EXIT}"
