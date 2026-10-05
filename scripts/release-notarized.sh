#!/usr/bin/env bash
#
# Build a signed + notarized macOS release. Requires an Apple Developer ID.
# See docs/NOTARIZATION.md for how to get the certificate + credentials.
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

missing=()
for v in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
# Allow the API-key method as an alternative to APPLE_ID/APPLE_PASSWORD.
if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
  missing=("${missing[@]/APPLE_ID}"); missing=("${missing[@]/APPLE_PASSWORD}")
fi
missing=("${missing[@]/#/}"); missing=("${missing[@]// /}")

real_missing=()
for v in "${missing[@]}"; do [ -n "$v" ] && real_missing+=("$v"); done
if [ "${#real_missing[@]}" -gt 0 ]; then
  echo "Missing env vars: ${real_missing[*]}" >&2
  echo "See docs/NOTARIZATION.md." >&2
  exit 1
fi

echo "Signing identity: $APPLE_SIGNING_IDENTITY"
echo "Building signed + notarized release…"
npm run tauri build
echo "Done. The .dmg in src-tauri/target/release/bundle/dmg/ is notarized."
