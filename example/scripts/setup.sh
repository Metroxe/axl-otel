#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="${ROOT}/scripts"
CONFIGS_DIR="${ROOT}/configs"

"${SCRIPTS}/generate-keys.sh"

mkdir -p "${CONFIGS_DIR}"

# Editor is the bootstrap node — listens on tls://0.0.0.0:9001 inside its
# container, reachable on the docker network as host "editor". Other agents
# (added later) will list "tls://editor:9001" in their Peers.
write_config() {
  local agent="$1"
  local listen="$2"
  local peers="$3"
  local out="${CONFIGS_DIR}/${agent}/node-config.json"
  mkdir -p "$(dirname "${out}")"
  cat > "${out}" <<EOF
{
  "PrivateKeyPath": "/etc/axl/private.pem",
  "Peers": ${peers},
  "Listen": ${listen},
  "bridge_addr": "127.0.0.1",
  "api_port": 9002
}
EOF
  echo "configs: wrote ${out#${ROOT}/}"
}

write_config editor '["tls://0.0.0.0:9001"]' '[]'
