# Signing & notarizing Sylph (macOS)

Right now Sylph ships **ad-hoc signed** (no Apple Developer account), so a browser
download shows Gatekeeper's *"damaged"* warning until the quarantine flag is
cleared. A **Developer ID signature + notarization** removes that warning entirely
— the app just opens.

Everything is already wired (`src-tauri/entitlements.plist`, `tauri.conf.json`).
You only need an Apple Developer account and a few environment variables.

## One-time setup

1. **Join the Apple Developer Program** ($99/yr) → <https://developer.apple.com/programs/>
2. **Create a "Developer ID Application" certificate** (Xcode → Settings → Accounts →
   Manage Certificates → +, or on the developer portal) and let it install into your
   login keychain. Find its name:
   ```bash
   security find-identity -v -p codesigning
   # e.g. "Developer ID Application: Your Name (TEAMID1234)"
   ```
3. **Create an app-specific password** for notarization at <https://appleid.apple.com>
   → Sign-In & Security → App-Specific Passwords.

## Build a signed + notarized release

Set these environment variables, then build — Tauri signs **and** notarizes
automatically (no code changes needed):

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID1234)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # the app-specific password
export APPLE_TEAM_ID="TEAMID1234"

npm run tauri build
```

Or use the helper, which checks the variables first:

```bash
./scripts/release-notarized.sh
```

The resulting `.dmg` opens with **no warnings** — no `xattr`, no curl trick.

> Alternative to Apple ID + password: an App Store Connect **API key**
> (`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`).

## What's already configured

- `src-tauri/entitlements.plist` — hardened-runtime entitlements for the mic, the
  WebView JIT, and the PyInstaller-frozen engine (unsigned exec memory + library
  validation disabled so the bundled engine runs under the hardened runtime).
- `tauri.conf.json` → `bundle.macOS.entitlements` points at it. These are ignored
  for the current ad-hoc build and applied automatically once you sign with a
  Developer ID.
