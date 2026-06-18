#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: bash scripts/package-plugin.sh <RunUAT.sh path> <package output dir>" >&2
  exit 1
fi

RUN_UAT="$1"
PACKAGE_DIR="$2"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING_DIR="$(mktemp -d)"
PLUGIN_STAGE="$STAGING_DIR/UnrealEditorWebUI"

if [[ ! -f "$RUN_UAT" ]]; then
  echo "RunUAT path not found: $RUN_UAT" >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required to stage the plugin package." >&2
  exit 1
fi

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

mkdir -p "$PLUGIN_STAGE"

rsync -a --delete \
  --exclude ".git/" \
  --exclude ".DS_Store" \
  --exclude "Binaries/" \
  --exclude "DerivedDataCache/" \
  --exclude "Intermediate/" \
  --exclude "Saved/" \
  --exclude "frontend/node_modules/" \
  --exclude "frontend/dist/" \
  --exclude "node_modules/" \
  --exclude "Python/__pycache__/" \
  --exclude "tests/__pycache__/" \
  "$ROOT_DIR/" "$PLUGIN_STAGE/"

"$RUN_UAT" BuildPlugin \
  -Plugin="$PLUGIN_STAGE/UnrealEditorWebUI.uplugin" \
  -Package="$PACKAGE_DIR" \
  -Rocket
