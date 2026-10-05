#!/usr/bin/env bash
#
# Sylph installer — one command, no Gatekeeper "damaged" popup.
#
#   curl -fsSL https://themaker00001.github.io/sylph/install.sh | bash
#
# Why this avoids the "damaged" error: files fetched with curl are NOT given
# macOS's com.apple.quarantine flag (only browser downloads are), so Gatekeeper
# doesn't block the app. We also set up the on-device engine so it just works.
#
set -euo pipefail

REPO="themaker00001/sylph"
DMG_URL="https://github.com/$REPO/releases/latest/download/Sylph_0.1.0_aarch64.dmg"
SERVER_URL="https://raw.githubusercontent.com/$REPO/main/sidecar/server.py"
SUPPORT="$HOME/Library/Application Support/Sylph"
ENGINE="$SUPPORT/engine"
APP="/Applications/Sylph.app"

say()  { printf "\033[1m›\033[0m %s\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
die()  { printf "  \033[31m✗\033[0m %s\n" "$1" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "Sylph installs on macOS only."
[ "$(uname -m)" = "arm64" ] || warn "This build targets Apple Silicon (arm64)."

TMP="$(mktemp -d)"
trap 'hdiutil detach "$TMP/mnt" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

# ── 1. Download + install the app (no quarantine via curl) ─────────────────
say "Downloading Sylph…"
curl -f#L "$DMG_URL" -o "$TMP/Sylph.dmg" || die "download failed"
ok "downloaded"

say "Installing to /Applications…"
mkdir -p "$TMP/mnt"
hdiutil attach "$TMP/Sylph.dmg" -nobrowse -quiet -mountpoint "$TMP/mnt" || die "could not mount dmg"
rm -rf "$APP"
cp -R "$TMP/mnt/Sylph.app" /Applications/ || die "could not copy app (need permission to /Applications?)"
hdiutil detach "$TMP/mnt" -quiet || true
# belt + suspenders: strip any quarantine/attrs
xattr -cr "$APP" 2>/dev/null || true
ok "installed $APP"

# ── 2. Set up the on-device engine ─────────────────────────────────────────
PY=""
for c in python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1; then
    v="$("$c" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo "")"
    case "$v" in 3.10|3.11|3.12) PY="$c"; break;; *) [ -z "$PY" ] && PY="$c";; esac
  fi
done

if [ -z "$PY" ]; then
  warn "No python3 found — the app will install but can't transcribe yet."
  warn "Install Python 3.12 (brew install python@3.12), then re-run this script."
  say "Done (app only). Open Sylph from Launchpad once Python is set up."
  exit 0
fi

say "Setting up the Whistle engine with $PY…"
mkdir -p "$ENGINE"
"$PY" -m venv "$ENGINE/venv"
"$ENGINE/venv/bin/python" -m pip install --quiet --upgrade pip
"$ENGINE/venv/bin/python" -m pip install --quiet cactus-needle
curl -fsSL "$SERVER_URL" -o "$ENGINE/server.py"
ok "engine installed"

say "Warming the model (one-time ~17 MB download)…"
NEEDLE_TELEMETRY=0 "$ENGINE/venv/bin/python" - <<'PY' || warn "model warm-up failed; it will retry on first use"
import needle; needle.Whistle(); print("ok")
PY

# ── 3. Point the app at the engine ─────────────────────────────────────────
cat > "$SUPPORT/engine.json" <<JSON
{
  "python": "$ENGINE/venv/bin/python",
  "sidecar": "$ENGINE/server.py"
}
JSON
ok "linked engine to the app"

echo
say "Sylph is installed. 🎉"
echo "   • Open it from Launchpad (or: open -a Sylph)"
echo "   • Grant Microphone + Accessibility when asked"
echo "   • Double-tap Left Option to dictate, or hold to talk"
