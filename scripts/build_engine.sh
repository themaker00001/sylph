#!/usr/bin/env bash
#
# Freeze the Python transcription sidecar into a single self-contained binary
# with PyInstaller, and place it where Tauri will bundle it into Sylph.app.
# Runs automatically before `tauri build` (see beforeBuildCommand).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VENV="$ROOT/.venv"
PY="$VENV/bin/python"

if [ ! -x "$PY" ]; then
  echo "[build_engine] no .venv found — running setup.sh first"
  bash "$ROOT/scripts/setup.sh"
fi

echo "[build_engine] ensuring pyinstaller + cactus-needle"
"$PY" -m pip install --quiet --upgrade pip
"$PY" -m pip install --quiet pyinstaller cactus-needle

echo "[build_engine] freezing engine (PyInstaller, onefile)…"
"$VENV/bin/pyinstaller" --noconfirm --onefile --name sylph-engine \
  --collect-all needle \
  --distpath "$ROOT/build/engine-dist" \
  --workpath "$ROOT/build/engine-work" \
  --specpath "$ROOT/build" \
  "$ROOT/sidecar/server.py"

mkdir -p "$ROOT/src-tauri/resources"
cp "$ROOT/build/engine-dist/sylph-engine" "$ROOT/src-tauri/resources/sylph-engine"
chmod +x "$ROOT/src-tauri/resources/sylph-engine"
echo "[build_engine] done → src-tauri/resources/sylph-engine ($(du -h "$ROOT/src-tauri/resources/sylph-engine" | cut -f1))"
