#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -s)" == "Linux" ]] || exit 0
[[ $# == 2 ]] || { echo "usage: $0 SOURCE_TAR OUTPUT_DIR" >&2; exit 2; }

source_tar="$1"
output="$2"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock="${root}/runtime/native/managed-worker-linux/bubblewrap-0.11.2.lock.json"
build="$(mktemp -d)"
trap 'rm -rf "${build}"' EXIT

python3 - "${source_tar}" "${lock}" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

source = Path(sys.argv[1])
lock = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))["source"]
raw = source.read_bytes()
if len(raw) != lock["size_bytes"] or hashlib.sha256(raw).hexdigest() != lock["sha256"]:
    raise SystemExit("bubblewrap source identity changed")
PY

tar -xf "${source_tar}" -C "${build}" --no-same-owner --no-same-permissions
source="${build}/bubblewrap-0.11.2"
export SOURCE_DATE_EPOCH=0
export CFLAGS="-O2 -g0 -ffile-prefix-map=${build}=."
meson setup "${source}/_build" "${source}" \
  -Dselinux=disabled \
  -Dman=disabled \
  -Dtests=false \
  -Dbash_completion=disabled \
  -Dzsh_completion=disabled \
  -Dsupport_setuid=false \
  '-Dc_link_args=-Wl,-rpath,$ORIGIN' >/dev/null
meson compile -C "${source}/_build" >/dev/null
strip --strip-all "${source}/_build/bwrap"

libcap="$(ldd "${source}/_build/bwrap" | awk '$1 == "libcap.so.2" { print $3 }')"
[[ -f "${libcap}" ]] || { echo "bubblewrap libcap dependency is unavailable" >&2; exit 1; }
mkdir -p "${output}"
install -m 0755 "${source}/_build/bwrap" "${output}/shejane-bwrap"
install -m 0644 "${libcap}" "${output}/libcap.so.2"
install -m 0644 "${source}/COPYING" "${output}/COPYING.bubblewrap"
install -m 0644 /usr/share/doc/libcap2/copyright "${output}/copyright.libcap"

"${output}/shejane-bwrap" --version | grep -Fx 'bubblewrap 0.11.2' >/dev/null
"${output}/shejane-bwrap" --help | grep -F -- '--bind-fd' >/dev/null
"${output}/shejane-bwrap" --help | grep -F -- '--size' >/dev/null

python3 - "${output}" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
files = {}
for name in ("shejane-bwrap", "libcap.so.2", "COPYING.bubblewrap", "copyright.libcap"):
    raw = (root / name).read_bytes()
    files[name] = {"sha256": hashlib.sha256(raw).hexdigest(), "size_bytes": len(raw)}
(root / "manifest.json").write_text(
    json.dumps(
        {"schema_version": 1, "version": "0.11.2", "setuid": False, "files": files},
        sort_keys=True,
        separators=(",", ":"),
    ) + "\n",
    encoding="utf-8",
)
PY
