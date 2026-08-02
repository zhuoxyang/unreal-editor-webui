#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: bash scripts/package-plugin.sh <RunUAT.sh path> <package output dir> <40-character source commit>" >&2
  exit 1
fi

RUN_UAT="$1"
PACKAGE_INPUT="$2"
SOURCE_COMMIT="$3"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE_SCRIPT="$ROOT_DIR/scripts/stage-plugin-from-commit.mjs"

if [[ ${#SOURCE_COMMIT} -ne 40 || ! "$SOURCE_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "Source commit must be a full 40-character Git commit SHA." >&2
  exit 1
fi
if [[ ! -f "$RUN_UAT" ]]; then
  echo "RunUAT path not found: $RUN_UAT" >&2
  exit 1
fi
PACKAGE_PARENT_INPUT="$(dirname "$PACKAGE_INPUT")"
if [[ ! -d "$PACKAGE_PARENT_INPUT" ]]; then
  echo "Package output parent directory does not exist: $PACKAGE_PARENT_INPUT" >&2
  exit 1
fi
PACKAGE_PARENT="$(cd "$PACKAGE_PARENT_INPUT" && pwd -P)"
PACKAGE_NAME="$(basename "$PACKAGE_INPUT")"
if [[ "$PACKAGE_NAME" == "." || "$PACKAGE_NAME" == ".." || "$PACKAGE_NAME" == */* ]]; then
  echo "Package output must name a directory beneath an existing parent." >&2
  exit 1
fi
PACKAGE_DIR="$PACKAGE_PARENT/$PACKAGE_NAME"
if [[ -e "$PACKAGE_DIR" || -L "$PACKAGE_DIR" ]]; then
  echo "Package output directory must not already exist: $PACKAGE_DIR" >&2
  exit 1
fi

STAGING_DIR="$(mktemp -d)"
BUILD_PACKAGE_DIR=""
cleanup() {
  local original_status=$?
  local cleanup_failed=0
  if [[ -n "$BUILD_PACKAGE_DIR" && ( -e "$BUILD_PACKAGE_DIR" || -L "$BUILD_PACKAGE_DIR" ) ]]; then
    if ! rm -rf -- "$BUILD_PACKAGE_DIR"; then
      echo "Failed to remove private BuildPlugin output: $BUILD_PACKAGE_DIR" >&2
      cleanup_failed=1
    fi
  fi
  if ! rm -rf -- "$STAGING_DIR"; then
    echo "Failed to remove exact-commit staging directory: $STAGING_DIR" >&2
    cleanup_failed=1
  fi
  trap - EXIT
  if [[ $original_status -ne 0 ]]; then
    exit "$original_status"
  fi
  if [[ $cleanup_failed -ne 0 ]]; then
    exit 1
  fi
}
trap cleanup EXIT
PLUGIN_STAGE="$STAGING_DIR/UnrealEditorWebUI"
SOURCE_MANIFEST="$STAGING_DIR/SourceManifest.json"

node "$STAGE_SCRIPT" "$SOURCE_COMMIT" "$PLUGIN_STAGE" "$SOURCE_MANIFEST"

PLUGIN_DESCRIPTOR="$PLUGIN_STAGE/UnrealEditorWebUI.uplugin"
if [[ ! -f "$PLUGIN_DESCRIPTOR" ]]; then
  echo "Exact-commit staging did not create the plugin descriptor." >&2
  exit 1
fi
if [[ ! -f "$PLUGIN_STAGE/Web/dist/index.html" ]]; then
  echo "Exact-commit frontend build did not create Web/dist/index.html." >&2
  exit 1
fi
if [[ ! -f "$SOURCE_MANIFEST" ]]; then
  echo "Exact-commit staging did not create SourceManifest.json." >&2
  exit 1
fi
if [[ -e "$PACKAGE_DIR" || -L "$PACKAGE_DIR" ]]; then
  echo "Package output directory was created while exact-commit staging ran: $PACKAGE_DIR" >&2
  exit 1
fi
BUILD_PACKAGE_DIR="$(mktemp -d "$PACKAGE_PARENT/.unreal-editor-webui-package.XXXXXXXX")"

"$RUN_UAT" BuildPlugin \
  -Plugin="$PLUGIN_DESCRIPTOR" \
  -Package="$BUILD_PACKAGE_DIR" \
  -Rocket

test -f "$BUILD_PACKAGE_DIR/UnrealEditorWebUI.uplugin"
test -f "$BUILD_PACKAGE_DIR/Web/dist/index.html"
test -f "$BUILD_PACKAGE_DIR/LICENSE"
cmp -s "$PLUGIN_STAGE/LICENSE" "$BUILD_PACKAGE_DIR/LICENSE"
cp "$SOURCE_MANIFEST" "$BUILD_PACKAGE_DIR/SourceManifest.json"
if [[ -e "$PACKAGE_DIR" || -L "$PACKAGE_DIR" ]]; then
  echo "Package output directory was created before exact package publication: $PACKAGE_DIR" >&2
  exit 1
fi
if ! mkdir -- "$PACKAGE_DIR"; then
  echo "Package output directory could not be reserved without overwriting an existing path: $PACKAGE_DIR" >&2
  exit 1
fi

# POSIX rename may replace an empty directory created after the final check. Reserve the
# final name atomically with mkdir, then populate that directory. SourceManifest.json is
# moved last so it also serves as the completion marker for external consumers.
shopt -s dotglob nullglob
for package_entry in "$BUILD_PACKAGE_DIR"/*; do
  if [[ "$(basename "$package_entry")" == "SourceManifest.json" ]]; then
    continue
  fi
  mv -- "$package_entry" "$PACKAGE_DIR/"
done
shopt -u dotglob nullglob
mv -- "$BUILD_PACKAGE_DIR/SourceManifest.json" "$PACKAGE_DIR/SourceManifest.json"
rmdir -- "$BUILD_PACKAGE_DIR"
BUILD_PACKAGE_DIR=""
