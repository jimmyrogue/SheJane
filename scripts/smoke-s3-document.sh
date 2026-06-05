#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:8080}"
RUN_ID="$(date +%s)_$$"
EMAIL="${SMOKE_EMAIL:-s3-smoke+${RUN_ID}@shejane.local}"
PASSWORD="${SMOKE_PASSWORD:-SheJane123!}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 127
  fi
}

json_field() {
  JSON_PAYLOAD="$1" JSON_PATH="$2" node <<'NODE'
const payload = JSON.parse(process.env.JSON_PAYLOAD);
const path = process.env.JSON_PATH.split('.');
let value = payload;
for (const key of path) value = value?.[key];
if (value === undefined || value === null) process.exit(1);
process.stdout.write(String(value));
NODE
}

require_command curl
require_command node

echo "Checking API health at ${API_BASE_URL}"
curl -fsS "${API_BASE_URL}/health" >"${TMP_DIR}/health.json"

echo "Registering S3 document smoke user ${EMAIL}"
AUTH_RESPONSE="$(
  curl -fsS -X POST "${API_BASE_URL}/api/v1/auth/register" \
    -H "Content-Type: application/json" \
    --data "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\",\"name\":\"S3 Smoke\"}"
)"
ACCESS_TOKEN="$(json_field "$AUTH_RESPONSE" "data.access_token")"

cat >"${TMP_DIR}/smoke.pdf" <<'PDF'
%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF
PDF

SIZE_BYTES="$(wc -c <"${TMP_DIR}/smoke.pdf" | tr -d ' ')"
echo "Creating presigned upload for smoke.pdf (${SIZE_BYTES} bytes)"
UPLOAD_RESPONSE="$(
  curl -fsS -X POST "${API_BASE_URL}/api/v1/documents/uploads" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"filename\":\"smoke.pdf\",\"content_type\":\"application/pdf\",\"size_bytes\":${SIZE_BYTES}}"
)"
UPLOAD_URL="$(json_field "$UPLOAD_RESPONSE" "data.upload.url")"
DOCUMENT_ID="$(json_field "$UPLOAD_RESPONSE" "data.document.id")"

echo "Uploading source object for document ${DOCUMENT_ID}"
curl -fsS -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/pdf" \
  --data-binary @"${TMP_DIR}/smoke.pdf" >/dev/null

echo "Deleting smoke document metadata and source object"
curl -fsS -X DELETE "${API_BASE_URL}/api/v1/documents/${DOCUMENT_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" >/dev/null

echo "S3 document upload smoke finished"
