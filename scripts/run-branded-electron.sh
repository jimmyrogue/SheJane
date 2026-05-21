#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="${ROOT_DIR}/client"
APP_NAME="石间"
APP_ID="com.coldflame.shejane.dev"
WRAPPER_APP="${JIANDANLY_DEV_ELECTRON_APP:-${ROOT_DIR}/.tmp/dev/SheJane.app}"
SOURCE_APP="${CLIENT_DIR}/node_modules/electron/dist/Electron.app"
SOURCE_VERSION_FILE="${CLIENT_DIR}/node_modules/electron/dist/version"
WRAPPER_VERSION_FILE="${WRAPPER_APP}/Contents/Resources/.shejane-electron-version"

if [[ "$(uname -s)" != "Darwin" ]]; then
  exec "${CLIENT_DIR}/node_modules/.bin/electron" "$@"
fi

if [[ ! -d "$SOURCE_APP" ]]; then
  echo "Electron app bundle not found. Run npm install in ${CLIENT_DIR} first." >&2
  exit 1
fi

source_version="unknown"
if [[ -f "$SOURCE_VERSION_FILE" ]]; then
  source_version="$(cat "$SOURCE_VERSION_FILE")"
fi

if [[ ! -x "${WRAPPER_APP}/Contents/MacOS/Electron" ]] || [[ ! -f "$WRAPPER_VERSION_FILE" ]] || [[ "$(cat "$WRAPPER_VERSION_FILE")" != "$source_version" ]]; then
  rm -rf "$WRAPPER_APP"
  mkdir -p "$(dirname "$WRAPPER_APP")"
  /usr/bin/ditto "$SOURCE_APP" "$WRAPPER_APP"
  mkdir -p "$(dirname "$WRAPPER_VERSION_FILE")"
  printf '%s' "$source_version" > "$WRAPPER_VERSION_FILE"
fi

plutil -replace CFBundleName -string "$APP_NAME" "${WRAPPER_APP}/Contents/Info.plist"
plutil -replace CFBundleDisplayName -string "$APP_NAME" "${WRAPPER_APP}/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "$APP_ID" "${WRAPPER_APP}/Contents/Info.plist"
codesign --force --deep --sign - "$WRAPPER_APP" >/dev/null 2>&1 || true

exec "${WRAPPER_APP}/Contents/MacOS/Electron" "$@"
