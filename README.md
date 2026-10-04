<div align="center">

# ✴ Sylph

**Feather-light, on-device voice to text. Speak, and it flows.**

A cross-platform dictation app — a lighter, fully-local take on the Wispr Flow
experience. Press a hotkey in any app, speak, and your words are transcribed and
typed for you. No cloud, no account, no latency.

Powered by [Cactus **Whistle**](https://cactuscompute.com/blog/whistle) — a
16.9 MB speech model that runs entirely on your device.

</div>

---

## Why it's light

| | Sylph | Typical Electron dictation app |
|---|---|---|
| App shell | **Tauri 2** (Rust + system webview) | Electron (bundles Chromium) |
| Transcription | **Whistle**, on-device, 16.9 MB | cloud API or multi-GB model |
| Your audio | never leaves the machine | often uploaded |
| First token | ~11 ms (Apple M4 Pro) | network round-trip |

## Features

- **Global hotkey** — dictate from any app (default `⌘⇧Space`).
- **Floating pill** — a glassy capsule shows listening / transcribing state.
- **Auto-insert** — transcript is pasted (or typed) into the focused app.
- **History** — every dictation, stored locally, searchable.
- **Dictionary** — bias Whistle toward names and jargon it should nail.
- **7 languages** — English, German, French, Spanish, Italian, Dutch, Polish.
- **Private by default** — Cactus telemetry is disabled by the sidecar.

## Architecture

```
┌──────────────────────────────┐        ┌─────────────────────────────┐
│  Tauri shell (Rust)          │        │  Python sidecar             │
│  • global hotkey             │  JSON  │  • cactus-needle / Whistle  │
│  • text insertion (enigo)    │ stdio  │  • model resident in RAM    │
│  • history + settings        │◄──────►│  • transcribe(wav)→text     │
│                              │        └─────────────────────────────┘
│  Webview (HTML/JS/CSS)       │
│  • main window + floating pill
│  • mic capture → 16 kHz WAV  │
└──────────────────────────────┘
```

The webview records the mic and encodes a 16 kHz mono WAV. Rust hands it to a
long-lived Python process that keeps the Whistle model loaded, so every
utterance is transcribed without reloading the model.

## Getting started

Requirements: **Rust**, **Node 18+**, and **Python 3.10–3.12**.

```bash
# 1. Python engine (creates .venv, installs Whistle, warms the model)
./scripts/setup.sh

# 2. JS tooling
npm install

# 3. Run
npm run tauri dev
```

### macOS permissions

On first run, grant:

- **Microphone** — to hear you (prompted automatically).
- **Accessibility** — System Settings → Privacy & Security → Accessibility →
  enable Sylph. This lets it paste into other apps.

## Build a release app

```bash
npm run build      # produces a .app / .dmg (macOS), .msi (Windows), etc.
```

> Note: the release bundle currently expects the `.venv` sidecar alongside it.
> Freezing the Python sidecar with PyInstaller for a single-file installer is on
> the roadmap below.

## Roadmap

- [ ] Bundle the sidecar (PyInstaller) so no Python install is needed.
- [ ] Push-to-talk (hold) mode in addition to toggle.
- [ ] Non-activating pill panel on macOS for flawless focus return.
- [ ] Streaming / live partial transcripts.
- [ ] Menu-bar / tray quick toggle.

## Credits

- Speech model: [Cactus Whistle](https://cactuscompute.com/blog/whistle)
  (`cactus-needle`, Apache-2.0).
- Shell: [Tauri](https://tauri.app).

## License

Apache-2.0.
