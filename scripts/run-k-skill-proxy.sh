#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="${KSKILL_SECRETS_FILE:-$HOME/.config/k-skill/secrets.env}"
AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/k-skill/age/keys.txt}"

if ! command -v sops >/dev/null 2>&1; then
  echo "missing command: sops" >&2
  exit 1
fi

if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "missing encrypted secrets file: $SECRETS_FILE" >&2
  exit 1
fi

if [[ ! -f "$AGE_KEY_FILE" ]]; then
  echo "missing age key file: $AGE_KEY_FILE" >&2
  exit 1
fi

cd "$ROOT_DIR"
exec env SOPS_AGE_KEY_FILE="$AGE_KEY_FILE" \
  sops exec-env "$SECRETS_FILE" 'node packages/k-skill-proxy/src/server.js'
