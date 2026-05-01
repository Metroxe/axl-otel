#!/usr/bin/env bash
set -euo pipefail

CONFIG="${AXL_CONFIG:-/etc/axl/node-config.json}"

if [[ ! -f "${CONFIG}" ]]; then
  echo "entrypoint: no AXL config at ${CONFIG}" >&2
  exit 1
fi

# 1. AXL Go node — Yggdrasil bridge + HTTP API on :9002
cd "$(dirname "${CONFIG}")"
axl-node -config "${CONFIG}" &
AXL_PID=$!

# 2. AXL Python MCP router on :9003 — bridges incoming MCP traffic to the
# local MCP server. Bundled with the AXL repo under integrations/.
python -m mcp_routing.mcp_router --port 9003 &
ROUTER_PID=$!

# 3. OTel sidecar — listens on :4318 for OTLP, routes spans by originator.
SIDECAR_ARGS=(
  --axl-url "${AXL_URL:-http://127.0.0.1:9002}"
  --otlp-url "${OTLP_URL:-http://jaeger:4318}"
  --listen-host 127.0.0.1
  --listen-port 4318
)
if [[ -n "${SIDECAR_RECEIVE:-}" ]]; then
  SIDECAR_ARGS+=(--receive)
fi
cd /sidecar
bun run src/index.ts "${SIDECAR_ARGS[@]}" &
SIDECAR_PID=$!

# 4. Agent code — registers an MCP server with the router and serves tools.
cd /app
bun run src/index.ts &
APP_PID=$!

shutdown() {
  kill -TERM "${AXL_PID}" "${ROUTER_PID}" "${SIDECAR_PID}" "${APP_PID}" 2>/dev/null || true
}
trap shutdown INT TERM

wait -n "${AXL_PID}" "${ROUTER_PID}" "${SIDECAR_PID}" "${APP_PID}"
EXIT=$?
shutdown
wait || true
exit "${EXIT}"
