#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="${ROOT_DIR}/client"
DOCK_LANG_FILE="${ROOT_DIR}/.tmp/dev/dock-lang"
APP_LANG="zh"
if [[ -f "$DOCK_LANG_FILE" ]]; then
  case "$(tr -d '[:space:]' < "$DOCK_LANG_FILE")" in
    en) APP_LANG="en" ;;
    zh) APP_LANG="zh" ;;
  esac
fi
if [[ "$APP_LANG" == "en" ]]; then
  APP_NAME="SheJane"
else
  APP_NAME="石间"
fi
APP_ID="com.coldflame.shejane.dev"
WRAPPER_APP="${SHEJANE_DEV_ELECTRON_APP:-${ROOT_DIR}/.tmp/dev/SheJane.app}"
SOURCE_APP="${CLIENT_DIR}/node_modules/electron/dist/Electron.app"
SOURCE_VERSION_FILE="${CLIENT_DIR}/node_modules/electron/dist/version"
WRAPPER_VERSION_FILE="${WRAPPER_APP}/Contents/Resources/.shejane-electron-version"
# Branded .icns drives the icon shown in macOS notifications, the App
# Switcher, the Dock, "About" panel and Finder. The runtime
# `new Notification({icon: ...})` field is IGNORED on macOS — the OS
# always pulls from the bundle's icon resource. Generated once from
# client/electron/assets/app-icon.png; regenerate via:
#   cd client/electron/assets && mkdir -p app-icon.iconset && \
#     for s in 16 32 128 256 512; do
#       sips -z "$s" "$s" app-icon.png --out "app-icon.iconset/icon_${s}x${s}.png"
#       d=$((s*2)); sips -z "$d" "$d" app-icon.png --out "app-icon.iconset/icon_${s}x${s}@2x.png"
#     done; cp app-icon.png app-icon.iconset/icon_512x512@2x.png && \
#     iconutil -c icns app-icon.iconset -o app-icon.icns && rm -rf app-icon.iconset
BRAND_ICNS="${CLIENT_DIR}/electron/assets/app-icon.icns"
BRAND_ICNS_VERSION_FILE="${WRAPPER_APP}/Contents/Resources/.shejane-icon-version"
export SHEJANE_DOCK_LANG_FILE="$DOCK_LANG_FILE"

if [[ "$(uname -s)" != "Darwin" ]]; then
  exec "${CLIENT_DIR}/node_modules/.bin/electron" "$@"
fi

if [[ ! -d "$SOURCE_APP" ]]; then
  echo "Electron app bundle not found. Run pnpm install from ${ROOT_DIR} first." >&2
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

# Replace the bundle's stock Electron .icns with our branded one. Only
# re-copy when the source file's checksum changed since the last run —
# otherwise we'd force-resign the bundle every dev startup for nothing.
# The Info.plist's CFBundleIconFile (and IconName under newer keys)
# already points at `electron.icns`, so overwriting that filename in
# place is the cleanest path — no plist edits required.
if [[ -f "$BRAND_ICNS" ]]; then
  brand_icns_hash="$(/sbin/md5 -q "$BRAND_ICNS" 2>/dev/null || md5 -q "$BRAND_ICNS")"
  current_brand_hash=""
  if [[ -f "$BRAND_ICNS_VERSION_FILE" ]]; then
    current_brand_hash="$(cat "$BRAND_ICNS_VERSION_FILE")"
  fi
  if [[ "$brand_icns_hash" != "$current_brand_hash" ]]; then
    cp "$BRAND_ICNS" "${WRAPPER_APP}/Contents/Resources/electron.icns"
    printf '%s' "$brand_icns_hash" > "$BRAND_ICNS_VERSION_FILE"
    # macOS caches icons aggressively per-bundle-id. Touching the
    # bundle invalidates Finder's cache; killing the badge service
    # ensures the Notification Center picks up the new icon without a
    # full logout.
    touch "$WRAPPER_APP"
    killall -HUP NotificationCenter 2>/dev/null || true
  fi
fi

codesign --force --deep --sign - "$WRAPPER_APP" >/dev/null 2>&1 || true

exec "${WRAPPER_APP}/Contents/MacOS/Electron" "$@"
