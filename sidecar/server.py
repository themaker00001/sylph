#!/usr/bin/env python3
"""
Sylph transcription sidecar.

A long-lived process that loads the Cactus **Whistle** model once and then
answers newline-delimited JSON requests on stdin, replying with one JSON
object per line on stdout. Keeping the model resident makes each dictation
near-instant (no reload per utterance).

Protocol
--------
Request  (one JSON object per line on stdin):
    {"id": 1, "cmd": "ping"}
    {"id": 2, "cmd": "transcribe", "wav_path": "/tmp/x.wav",
     "language": null, "keywords": ["Cactus", "Sylph"]}

Response (one JSON object per line on stdout):
    {"id": 1, "ok": true, "ready": true}
    {"id": 2, "ok": true, "text": "...", "language": "en",
     "ttft_ms": 11.1, "decode_tps": 1300.0}
    {"id": 2, "ok": false, "error": "..."}

All human-readable logging goes to stderr so stdout stays a clean JSON stream.
"""

import json
import os
import sys
import traceback

# Privacy first: this is a dictation tool. Disable Cactus's anonymous telemetry
# before importing the engine. (Set SYLPH_ALLOW_TELEMETRY=1 to opt back in.)
if os.environ.get("SYLPH_ALLOW_TELEMETRY") != "1":
    os.environ["NEEDLE_TELEMETRY"] = "0"


def log(*args):
    print("[sylph-sidecar]", *args, file=sys.stderr, flush=True)


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    try:
        import needle
    except Exception as exc:  # pragma: no cover
        send({"ok": False, "fatal": True,
              "error": f"failed to import needle: {exc}"})
        return 1

    log("loading Whistle model (first run downloads ~17 MB from Hugging Face)...")
    try:
        model = needle.Whistle()
    except Exception as exc:
        send({"ok": False, "fatal": True,
              "error": f"failed to load Whistle: {exc}"})
        log(traceback.format_exc())
        return 1

    log("model ready")
    # Announce readiness so the host can flip the UI out of "starting" state.
    send({"ok": True, "ready": True, "event": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            send({"ok": False, "error": f"bad json: {exc}"})
            continue

        rid = req.get("id")
        cmd = req.get("cmd", "transcribe")

        if cmd == "ping":
            send({"id": rid, "ok": True, "ready": True})
            continue

        if cmd == "shutdown":
            send({"id": rid, "ok": True, "bye": True})
            break

        if cmd == "transcribe":
            wav_path = req.get("wav_path")
            if not wav_path or not os.path.exists(wav_path):
                send({"id": rid, "ok": False,
                      "error": f"wav not found: {wav_path!r}"})
                continue
            try:
                keywords = req.get("keywords") or None
                language = req.get("language") or None
                res = model.transcribe(
                    wav_path,
                    language=language,
                    keywords=keywords,
                )
                text = (res.get("text") or "").strip()
                send({
                    "id": rid,
                    "ok": True,
                    "text": text,
                    "language": res.get("language"),
                    "ttft_ms": res.get("ttft_ms"),
                    "decode_tps": res.get("decode_tps"),
                })
            except Exception as exc:
                send({"id": rid, "ok": False, "error": str(exc)})
                log(traceback.format_exc())
            continue

        send({"id": rid, "ok": False, "error": f"unknown cmd: {cmd!r}"})

    log("sidecar exiting")
    return 0


if __name__ == "__main__":
    sys.exit(main())
