#!/usr/bin/env bash
#
# Sylph setup — creates the Python environment for the transcription sidecar
# and warms the Whistle model so the first dictation is instant.
#
# Usage:  ./scripts/setup.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Pick a Python the Cactus wheels support (3.10–3.12 are safest; 3.13+ may lack wheels).
PY=""
for cand in python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1; then
    ver="$("$cand" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
    case "$ver" in
      3.10|3.11|3.12) PY="$cand"; break ;;
      *) [ -z "$PY" ] && PY="$cand" ;;  # fall back, but keep looking
    esac
  fi
done

if [ -z "$PY" ]; then
  echo "error: no python3 found on PATH" >&2
  exit 1
fi
echo "==> Using $PY ($("$PY" --version 2>&1))"

echo "==> Creating virtualenv at .venv"
"$PY" -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate

echo "==> Installing dependencies"
python -m pip install --quiet --upgrade pip
python -m pip install -r sidecar/requirements.txt

echo "==> Warming the Whistle model (downloads ~17 MB on first run)"
NEEDLE_TELEMETRY=0 python - <<'PY'
import needle
m = needle.Whistle()
print("Whistle model loaded and cached.")
PY

echo
echo "Done. Python sidecar is ready at: $ROOT/.venv/bin/python"
echo "Next: npm install && npm run tauri dev"
