#!/usr/bin/env bash
#
# Sylph installer — one command, no "damaged" popup, no dependencies.
#
#   curl -fsSL https://themaker00001.github.io/sylph/install.sh | bash
#
# Files fetched with curl are NOT quarantined by macOS (only browser downloads
# are), so Gatekeeper doesn't block the app. The transcription engine is frozen
# inside the app (PyInstaller), so there's nothing else to install.
#
set -euo pipefail

REPO="themaker00001/sylph"
DMG_URL="https://github.com/$REPO/releases/latest/download/Sylph_0.1.0_aarch64.dmg"
APP="/Applications/Sylph.app"

say()  { printf "\033[1m›\033[0m %s\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
die()  { printf "  \033[31m✗\033[0m %s\n" "$1" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "Sylph installs on macOS only."
[ "$(uname -m)" = "arm64" ] || warn "This build targets Apple Silicon (arm64)."

TMP="$(mktemp -d)"
trap 'hdiutil detach "$TMP/mnt" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

say "Downloading Sylph…"
curl -f#L "$DMG_URL" -o "$TMP/Sylph.dmg" || die "download failed"
ok "downloaded"

say "Installing to /Applications…"
mkdir -p "$TMP/mnt"
hdiutil attach "$TMP/Sylph.dmg" -nobrowse -quiet -mountpoint "$TMP/mnt" || die "could not mount dmg"
rm -rf "$APP"
cp -R "$TMP/mnt/Sylph.app" /Applications/ || die "could not copy to /Applications"
hdiutil detach "$TMP/mnt" -quiet || true
xattr -cr "$APP" 2>/dev/null || true   # strip any quarantine, just in case
ok "installed $APP"

echo
say "Sylph is installed. 🎉"
echo "   • Open it from Launchpad (or:  open -a Sylph )"
echo "   • On first launch it downloads a 16.9 MB model (one time), then runs offline"
echo "   • Grant Microphone + Accessibility when asked"
echo "   • Double-tap Left Option to dictate, or hold to talk"
