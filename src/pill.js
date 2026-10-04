// Sylph — floating pill logic.
// Driven by the global hotkey (via a Tauri event) or a click. Records, sends
// audio to Whistle, then inserts the text into whatever app had focus.
import { createRecorder } from "./audio.js";

const TAURI = !!window.__TAURI__;
const invoke = TAURI ? window.__TAURI__.core.invoke : async (c) =>
  c === "get_settings" ? { auto_insert: true, insert_mode: "paste", language: "auto", keywords: [] } :
  c === "transcribe" ? { text: "Hello from Sylph.", language: "en", ttft_ms: 9, decode_tps: 1200 } : null;
const listen = TAURI ? window.__TAURI__.event.listen : async () => () => {};
const emit = TAURI ? window.__TAURI__.event.emit : async () => {};

const pill = document.getElementById("pill");
const label = document.getElementById("label");
const bars = document.getElementById("bars");
for (let i = 0; i < 20; i++) bars.appendChild(document.createElement("span"));
const barEls = [...bars.children];

let recorder = null, recording = false, busy = false, level = 0, timer = null;

function setLabel(t) { label.textContent = t; }
function animate() {
  barEls.forEach((s, i) => {
    const h = 5 + Math.abs(Math.sin(Date.now() / 110 + i * 0.5)) * (6 + level * 40);
    s.style.height = Math.min(26, h) + "px";
  });
}

async function start() {
  if (recording || busy) return;
  recorder = createRecorder({ onLevel: (l) => (level = l) });
  try {
    await recorder.start();
  } catch (e) {
    setLabel("Mic blocked"); return;
  }
  recording = true;
  pill.classList.add("live");
  timer = setInterval(animate, 55);
}

async function stop() {
  if (!recording) return;
  recording = false;
  busy = true;
  clearInterval(timer);
  pill.classList.remove("live");
  setLabel("Transcribing…");

  const { wavBase64, durationSec } = await recorder.stop();
  try {
    const settings = await invoke("get_settings");
    const res = await invoke("transcribe", { wavBase64 });
    const text = (res && res.text) || "";

    if (text) {
      setLabel("✓ " + (text.length > 26 ? text.slice(0, 26) + "…" : text));
      await invoke("add_history", {
        entry: { text, language: res.language, at: Date.now(), seconds: +durationSec.toFixed(1) },
      });
      await emit("sylph://transcribed", { text });

      if (settings.auto_insert) {
        // Hide the pill first so macOS returns key focus to the previous app,
        // then paste/type into it.
        await invoke("hide_pill");
        await new Promise((r) => setTimeout(r, 140));
        await invoke("insert_text", { text });
      }
    } else {
      setLabel("No speech heard");
    }
  } catch (e) {
    setLabel("Error: " + e);
  }
  busy = false;
  setTimeout(() => { if (!recording) { setLabel("Press hotkey to speak"); invoke("hide_pill"); } }, 1400);
}

function toggle() { recording ? stop() : start(); }

// Hotkey toggle from the backend.
listen("sylph://toggle", toggle);

// Click the pill to stop (while recording) or start.
pill.addEventListener("click", (e) => {
  // ignore drags
  if (e.detail === 0) return;
  toggle();
});
