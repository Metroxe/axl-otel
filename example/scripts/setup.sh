#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS="${ROOT}/scripts"
KEYS_DIR="${ROOT}/keys"
CONFIGS_DIR="${ROOT}/configs"

"${SCRIPTS}/generate-keys.sh"

mkdir -p "${CONFIGS_DIR}"

# Derive the raw 32-byte ed25519 public key (hex) from a PEM private key.
# The DER SubjectPublicKeyInfo for ed25519 ends with the 32 raw key bytes.
pubkey_hex() {
  local pem="$1"
  openssl pkey -in "${pem}" -pubout -outform DER \
    | tail -c 32 \
    | xxd -p -c 64
}

EDITOR_PUB="$(pubkey_hex "${KEYS_DIR}/editor.pem")"

# Editor is the bootstrap node — listens on tls://0.0.0.0:9001 inside its
# container, reachable on the docker network as host "editor". The other four
# agents reference editor as their sole peer; AXL handles transitive discovery.
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
  "api_port": 9002,
  "router_addr": "http://127.0.0.1",
  "router_port": 9003
}
EOF
  echo "configs: wrote ${out#${ROOT}/}"
}

write_config editor       '["tls://0.0.0.0:9001"]' '[]'
write_config researcher   '["tls://0.0.0.0:9001"]' "[\"tls://editor:9001?key=${EDITOR_PUB}\"]"
write_config web-search   '["tls://0.0.0.0:9001"]' "[\"tls://editor:9001?key=${EDITOR_PUB}\"]"
write_config fact-checker '["tls://0.0.0.0:9001"]' "[\"tls://editor:9001?key=${EDITOR_PUB}\"]"
write_config citation-db  '["tls://0.0.0.0:9001"]' "[\"tls://editor:9001?key=${EDITOR_PUB}\"]"

# Per-agent peer ID files so agents can address each other without re-deriving
# keys at runtime. Each container mounts this directory at /etc/axl/peers.
PEERS_DIR="${ROOT}/configs/peers"
mkdir -p "${PEERS_DIR}"
for agent in editor researcher web-search fact-checker citation-db; do
  pubkey_hex "${KEYS_DIR}/${agent}.pem" > "${PEERS_DIR}/${agent}.id"
done
echo "configs: wrote peer ID map under ${PEERS_DIR#${ROOT}/}"
