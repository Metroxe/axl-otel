#!/usr/bin/env bash
set -euo pipefail

AGENTS=(editor)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYS_DIR="${ROOT}/keys"
mkdir -p "${KEYS_DIR}"

for agent in "${AGENTS[@]}"; do
  key="${KEYS_DIR}/${agent}.pem"
  if [[ -f "${key}" ]]; then
    echo "keys: ${agent}.pem already exists, skipping"
    continue
  fi
  openssl genpkey -algorithm ed25519 -out "${key}"
  chmod 600 "${key}"
  echo "keys: generated ${agent}.pem"
done
