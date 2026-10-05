// Sylph — main window logic.
import { createRecorder } from "./audio.js";

// ── Tauri bridge (with a browser mock so the UI runs anywhere) ────────────
const TAURI = !!window.__TAURI__;
const invoke = TAURI
  ? window.__TAURI__.core.invoke
  : mockInvoke;
const listen = TAURI
  ? window.__TAURI__.event.listen
  : async () => () => {};

const isMac = navigator.platform.toLowerCase().includes("mac") ||
  navigator.userAgent.includes("Mac");

// ── Mock backend for plain-browser preview ────────────────────────────────
function mockInvoke(cmd, args) {
  const LS = window.localStorage;
  switch (cmd) {
    case "start_engine":
    case "engine_ready":
      return Promise.resolve(true);
    case "get_settings":
      return Promise.resolve(JSON.parse(LS.getItem("sylph.settings") || "null") || {
        language: "auto", insert_mode: "paste", auto_insert: true, sound: true, keywords: [],
        trigger: "option_left", invisible_pill: false, scratchpad: true, scratch_seconds: 8,
        theme: "system",
      });
    case "update_settings":
      LS.setItem("sylph.settings", JSON.stringify(args.settings)); return Promise.resolve();
    case "get_history":
      return Promise.resolve(JSON.parse(LS.getItem("sylph.history") || "[]"));
    case "add_history": {
      const h = JSON.parse(LS.getItem("sylph.history") || "[]");
      h.unshift(args.entry); LS.setItem("sylph.history", JSON.stringify(h.slice(0, 500)));
      return Promise.resolve();
    }
    case "clear_history": LS.setItem("sylph.history", "[]"); return Promise.resolve();
    case "transcribe":
      return new Promise((r) => setTimeout(() => r({
        text: "This is a simulated transcript — run inside Sylph for the real Whistle engine.",
        language: "en", ttft_ms: 9.4, decode_tps: 1288.2,
      }), 700));
    case "insert_text": return Promise.resolve();
    case "capture_trigger": return new Promise((r) => setTimeout(() => r("RControl"), 600));
    default: return Promise.resolve(null);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function fmtHotkey(acc) {
  return acc
    .replace("CmdOrCtrl", isMac ? "⌘" : "Ctrl")
    .replace("CommandOrControl", isMac ? "⌘" : "Ctrl")
    .replace("Cmd", "⌘").replace("Command", "⌘")
    .replace("Ctrl", isMac ? "⌃" : "Ctrl").replace("Control", isMac ? "⌃" : "Ctrl")
    .replace("Shift", "⇧").replace("Alt", isMac ? "⌥" : "Alt").replace("Option", "⌥")
    .replaceAll("+", "");
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 1900);
}

let settings = null;

// ── Navigation ─────────────────────────────────────────────────────────────
$("#nav").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-page]");
  if (!btn) return;
  $$(".nav button").forEach((b) => b.classList.toggle("active", b === btn));
  const page = btn.dataset.page;
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${page}`));
  if (page === "history") renderHistory();
});

// ── Engine status + first-run onboarding ─────────────────────────────────────
async function initEngine() {
  const dot = $("#engineDot"), label = $("#engineLabel");
  const firstRun = !localStorage.getItem("sylph.onboarded");
  const ob = $("#onboarding");

  let stepTimer = null;
  if (firstRun) {
    ob.classList.add("show");
    // Advance to the "fetch model" step shortly after starting.
    stepTimer = setTimeout(() => {
      $("#obStep1").classList.add("done");
      $("#obStep2").classList.add("active");
      $("#obStatus").textContent = "Downloading the Whistle model (16.9 MB)…";
    }, 900);
  }

  try {
    const ready = await invoke("start_engine");
    if (stepTimer) clearTimeout(stepTimer);
    dot.className = "dot on";
    label.textContent = ready ? "Whistle ready" : "Engine running";

    if (firstRun) {
      $("#obStep1").classList.add("done");
      $("#obStep2").classList.add("done");
      $("#obStep3").classList.add("active", "done");
      $("#obStatus").textContent = "All set — Whistle is ready.";
      localStorage.setItem("sylph.onboarded", "1");
      setTimeout(() => { ob.style.opacity = "0"; ob.style.transition = "opacity .4s"; }, 650);
      setTimeout(() => ob.classList.remove("show"), 1100);
    }
  } catch (err) {
    if (stepTimer) clearTimeout(stepTimer);
    dot.className = "dot";
    label.textContent = "Engine offline";
    if (firstRun) {
      // show a clean error state, not the half-finished progress
      const bar = document.querySelector(".ob-progress");
      const steps = document.querySelector(".ob-steps");
      if (bar) bar.style.display = "none";
      if (steps) steps.style.display = "none";
      $("#obTitle").textContent = "Couldn't start the engine";
      $("#obDesc").textContent = "Sylph couldn't launch its on-device engine. Please reinstall, or make sure macOS didn't block it.";
      $("#obStatus").textContent = String(err);
    }
    toast("Engine error: " + err);
  }
}

// ── Dictate (in-window try) ─────────────────────────────────────────────────
let recorder = null, recording = false, waveTimer = null;

function buildWave() {
  const w = $("#wave"); w.innerHTML = "";
  for (let i = 0; i < 24; i++) w.appendChild(document.createElement("span"));
}
function animateWave(level) {
  $$("#wave span").forEach((s, i) => {
    const base = 8 + Math.sin(Date.now() / 120 + i) * 6;
    s.style.height = Math.max(5, base + level * 34 * Math.random()) + "px";
  });
}

async function startRec() {
  recorder = createRecorder({ onLevel: (lvl) => (startRec._lvl = lvl) });
  try {
    await recorder.start();
  } catch (err) {
    toast("Microphone blocked: " + err.message);
    return;
  }
  recording = true;
  $("#micBtn").classList.add("rec");
  $("#heroStatus").textContent = "Listening… tap to stop";
  $("#wave").style.display = "flex";
  buildWave();
  waveTimer = setInterval(() => animateWave(startRec._lvl || 0), 60);
}

async function stopRec() {
  recording = false;
  clearInterval(waveTimer);
  $("#micBtn").classList.remove("rec");
  $("#wave").style.display = "none";
  $("#heroStatus").textContent = "Transcribing…";
  const { wavBase64, durationSec } = await recorder.stop();
  try {
    const res = await invoke("transcribe", { wavBase64 });
    const box = $("#transcript");
    box.classList.remove("empty");
    box.textContent = res.text || "(no speech detected)";
    $("#metrics").style.display = "flex";
    $("#mTtft").textContent = res.ttft_ms ? res.ttft_ms.toFixed(1) + " ms" : "–";
    $("#mTps").textContent = res.decode_tps ? Math.round(res.decode_tps) + " tok/s" : "–";
    $("#mLang").textContent = (res.language || "–").toUpperCase();
    $("#heroStatus").textContent = "Tap to try it here";
    if (res.text) {
      await invoke("add_history", {
        entry: { text: res.text, language: res.language, at: Date.now(), seconds: +durationSec.toFixed(1) },
      });
    }
  } catch (err) {
    $("#heroStatus").textContent = "Tap to try it here";
    toast("Transcription failed: " + err);
  }
}

$("#micBtn").addEventListener("click", () => (recording ? stopRec() : startRec()));

// ── History ─────────────────────────────────────────────────────────────────
async function renderHistory(filter = "") {
  const list = await invoke("get_history");
  const el = $("#histList");
  const items = list.filter((h) => !filter || (h.text || "").toLowerCase().includes(filter.toLowerCase()));
  if (!items.length) {
    el.innerHTML = `<div class="empty-state">
      <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>
      <div>${filter ? "No matches." : "No dictations yet. Press your hotkey and speak."}</div></div>`;
    return;
  }
  el.innerHTML = items.map((h, i) => `
    <div class="hist-item">
      <div class="meta">
        <span class="tag">${(h.language || "–").toUpperCase()}</span>
        <span>${new Date(h.at).toLocaleString()}</span>
        ${h.seconds ? `<span>· ${h.seconds}s</span>` : ""}
      </div>
      <div class="txt">${escapeHtml(h.text || "")}</div>
      <div class="acts"><button class="btn" data-copy="${i}">Copy</button></div>
    </div>`).join("");
  el.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => {
    navigator.clipboard.writeText(items[+b.dataset.copy].text || "");
    toast("Copied to clipboard");
  }));
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

$("#histSearch").addEventListener("input", (e) => renderHistory(e.target.value));
$("#clearHist").addEventListener("click", async () => {
  await invoke("clear_history"); renderHistory(); toast("History cleared");
});

// ── Dictionary ───────────────────────────────────────────────────────────────
function renderChips() {
  const el = $("#chips");
  el.innerHTML = (settings.keywords || []).map((k, i) =>
    `<span class="chip">${escapeHtml(k)}<button data-del="${i}">×</button></span>`).join("") ||
    `<span style="color:var(--text-faint);font-size:13px">No terms yet.</span>`;
  el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    settings.keywords.splice(+b.dataset.del, 1);
    await saveSettings(); renderChips();
  }));
}
async function addKeyword() {
  const inp = $("#kwInput"); const v = inp.value.trim();
  if (!v) return;
  settings.keywords = settings.keywords || [];
  if (!settings.keywords.includes(v)) settings.keywords.push(v);
  inp.value = ""; await saveSettings(); renderChips();
}
$("#kwAdd").addEventListener("click", addKeyword);
$("#kwInput").addEventListener("keydown", (e) => e.key === "Enter" && addKeyword());

// ── Settings ─────────────────────────────────────────────────────────────────
async function saveSettings() { await invoke("update_settings", { settings }); }

const KEY_LABEL = {
  option_left: "⌥ Option", option_right: "⌥ Option R", control_left: "⌃ Control",
  control_right: "⌃ Control R", shift_left: "⇧ Shift", shift_right: "⇧ Shift R", command: "⌘ Command",
};
// device_query debug name → our logical token (so modifiers display & store cleanly)
const DEVICE_TO_LOGICAL = {
  LOption: "option_left", ROption: "option_right", LAlt: "option_left", RAlt: "option_right",
  LControl: "control_left", RControl: "control_right", LShift: "shift_left", RShift: "shift_right",
  Command: "command", LMeta: "command", RMeta: "command", Meta: "command",
  command_left: "command", // legacy
};
function normTrigger(t) { return DEVICE_TO_LOGICAL[t] || t || "option_left"; }
function triggerLabel(t) { const n = normTrigger(t); return KEY_LABEL[n] || n; }

function applyTheme(t) {
  const el = document.documentElement;
  if (t === "light" || t === "dark") el.setAttribute("data-theme", t);
  else el.removeAttribute("data-theme");
}

function applySettingsToUI() {
  applyTheme(settings.theme || "system");
  $("#themeSel").value = settings.theme || "system";
  const trig = normTrigger(settings.trigger);
  $("#heroHotkey").textContent = triggerLabel(trig);
  const sel = $("#triggerSel");
  if (![...sel.options].some((o) => o.value === trig)) {
    const o = document.createElement("option");
    o.value = trig; o.textContent = KEY_LABEL[trig] || trig; sel.appendChild(o);
  }
  sel.value = trig;
  $("#langSel").value = settings.language;
  $("#insertSel").value = settings.insert_mode;
  $("#autoIns").checked = settings.auto_insert;
  $("#soundTgl").checked = settings.sound;
  $("#invisTgl").checked = !!settings.invisible_pill;
  $("#scratchTgl").checked = settings.scratchpad !== false;
  $("#scratchSecSel").value = String(settings.scratch_seconds || 8);
}

$("#themeSel").addEventListener("change", (e) => { settings.theme = e.target.value; applyTheme(settings.theme); saveSettings(); });
$("#triggerSel").addEventListener("change", (e) => {
  settings.trigger = e.target.value; applySettingsToUI(); saveSettings();
  toast("Trigger set to " + triggerLabel(settings.trigger));
});
$("#recordKey").addEventListener("click", async () => {
  const btn = $("#recordKey");
  const old = btn.textContent;
  btn.textContent = "Press a key…"; btn.disabled = true;
  try {
    const name = await invoke("capture_trigger");
    if (name) {
      settings.trigger = normTrigger(name); applySettingsToUI(); saveSettings();
      toast("Trigger set to " + triggerLabel(settings.trigger));
    } else toast("No key captured — ensure Accessibility is granted, then try again");
  } catch (err) { toast("Capture failed: " + err); }
  btn.textContent = old; btn.disabled = false;
});
$("#langSel").addEventListener("change", (e) => { settings.language = e.target.value; saveSettings(); });
$("#insertSel").addEventListener("change", (e) => { settings.insert_mode = e.target.value; saveSettings(); });
$("#autoIns").addEventListener("change", (e) => { settings.auto_insert = e.target.checked; saveSettings(); });
$("#soundTgl").addEventListener("change", (e) => { settings.sound = e.target.checked; saveSettings(); });
$("#invisTgl").addEventListener("change", (e) => { settings.invisible_pill = e.target.checked; saveSettings(); });
$("#scratchTgl").addEventListener("change", (e) => { settings.scratchpad = e.target.checked; saveSettings(); });
$("#scratchSecSel").addEventListener("change", (e) => { settings.scratch_seconds = +e.target.value; saveSettings(); });

// ── Live pill events (reflect dictations done via the floating pill) ─────────
listen("sylph://transcribed", () => { renderHistory(); });

// ── Boot ─────────────────────────────────────────────────────────────────────
(async function boot() {
  settings = await invoke("get_settings");
  applySettingsToUI();
  renderChips();
  initEngine();
})();
