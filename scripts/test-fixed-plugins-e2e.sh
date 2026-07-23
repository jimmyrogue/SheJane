#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

echo "→ install pinned Browser QA Chromium"
pnpm --filter @shejane/client exec playwright install chromium

echo "→ Browser QA, Computer Use, and OCR adapter E2E"
SHEJANE_REQUIRE_FIXED_PLUGIN_E2E=1 \
  uv run --project runtime python -m pytest -q \
    runtime/tests/test_browser_qa_e2e.py \
    runtime/tests/test_computer_use_e2e.py \
    runtime/tests/test_ocr_worker.py::test_ocr_runtime_tool_e2e_persists_text_and_json_artifacts

host_system="$(uname -s | tr '[:upper:]' '[:lower:]')"
host_arch="$(uname -m)"
case "${host_arch}" in
  arm64|aarch64) host_arch="arm64" ;;
  x86_64|amd64) host_arch="amd64" ;;
esac

default_ocr_asset="${ROOT_DIR}/runtime/plugins/ocr/dist/rapidocr-runtime-3.9.1-${host_system}-${host_arch}.shejane-runtime-asset"
ocr_asset="${SHEJANE_RAPIDOCR_RUNTIME_ASSET:-${default_ocr_asset}}"

if [[ -f "${ocr_asset}" ]]; then
  echo "→ native RapidOCR quality and hostile-input E2E"
  SHEJANE_RAPIDOCR_RUNTIME_ASSET="${ocr_asset}" \
    uv run --project runtime python -m pytest -q runtime/tests/test_ocr_runtime_asset.py
elif [[ "${SHEJANE_REQUIRE_NATIVE_OCR_E2E:-0}" == "1" ]]; then
  echo "❌ native OCR Runtime Asset is required but unavailable: ${ocr_asset}" >&2
  exit 1
else
  echo "↷ native OCR quality gate not run: build or provide ${ocr_asset}"
  echo "  Set SHEJANE_REQUIRE_NATIVE_OCR_E2E=1 to make a missing asset fail."
fi
