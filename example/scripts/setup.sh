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
RESEARCHER_PUB="$(pubkey_hex "${KEYS_DIR}/researcher.pem")"
FACT_CHECKER_PUB="$(pubkey_hex "${KEYS_DIR}/fact-checker.pem")"

# Topology mirrors the demo's trust model: the editor only peers with the
# two middle agents it actually trusts (researcher, fact-checker). The two
# leaf agents (web-search, citation-db) sit behind those and never form
# direct peer links to the editor. Yggdrasil's key-routed mesh makes them
# reachable transitively for the return-trace path.
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

#                          listen                       peers
write_config editor       '["tls://0.0.0.0:9001"]'      '[]'
write_config researcher   '["tls://0.0.0.0:9001"]'      "[\"tls://editor:9001?key=${EDITOR_PUB}\"]"
write_config fact-checker '["tls://0.0.0.0:9001"]'      "[\"tls://editor:9001?key=${EDITOR_PUB}\"]"
write_config web-search   '[]'                          "[\"tls://researcher:9001?key=${RESEARCHER_PUB}\"]"
write_config citation-db  '[]'                          "[\"tls://fact-checker:9001?key=${FACT_CHECKER_PUB}\"]"

# Per-agent peer-id maps: each agent only sees the IDs of the peers it has
# permission to address by name. Leaf agents see no one (they're called,
# they don't call). Mounted at /etc/axl/peers in their container.
write_peer_map() {
  local agent="$1"
  shift
  local dir="${CONFIGS_DIR}/peers-${agent}"
  mkdir -p "${dir}"
  for peer in "$@"; do
    pubkey_hex "${KEYS_DIR}/${peer}.pem" > "${dir}/${peer}.id"
  done
  if [[ $# -eq 0 ]]; then
    : > "${dir}/.empty"
  fi
  echo "configs: wrote peer map for ${agent} (${*:-none})"
}

write_peer_map editor       researcher fact-checker
write_peer_map researcher   web-search
write_peer_map fact-checker citation-db
write_peer_map web-search
write_peer_map citation-db
