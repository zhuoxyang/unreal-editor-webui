#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: bash scripts/package-plugin.sh <RunUAT.sh path> <package output dir>" >&2
  exit 1
fi

RUN_UAT="$1"
PACKAGE_DIR="$2"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
FRONTEND_ENTRY="$ROOT_DIR/Web/dist/index.html"
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

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to build the React frontend before packaging." >&2
  exit 1
fi

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

(
  cd "$FRONTEND_DIR"
  npm ci
  npm run build
)

if [[ ! -f "$FRONTEND_ENTRY" ]]; then
  echo "Frontend build did not create the expected entry point: $FRONTEND_ENTRY" >&2
  exit 1
fi

mkdir -p "$PLUGIN_STAGE"
cp "$ROOT_DIR/UnrealEditorWebUI.uplugin" "$PLUGIN_STAGE/UnrealEditorWebUI.uplugin"

for directory_name in Config Content Platforms Python Resources Shaders Source Web; do
  source_directory="$ROOT_DIR/$directory_name"
  if [[ ! -d "$source_directory" ]]; then
    continue
  fi

  rsync -a --delete \
    --exclude ".DS_Store" \
    --exclude "__pycache__/" \
    --exclude "*.pyc" \
    --exclude "*.pyo" \
    "$source_directory/" "$PLUGIN_STAGE/$directory_name/"
done

"$RUN_UAT" BuildPlugin \
  -Plugin="$PLUGIN_STAGE/UnrealEditorWebUI.uplugin" \
  -Package="$PACKAGE_DIR" \
  -Rocket
