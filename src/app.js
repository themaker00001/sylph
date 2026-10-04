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
        hotkey: "CmdOrCtrl+Shift+Space", language: "auto", insert_mode: "paste",
        auto_insert: true, sound: true, keywords: [],
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

// ── Engine status ───────────────────────────────────────────────────────────
async function initEngine() {
  const dot = $("#engineDot"), label = $("#engineLabel");
  try {
    const ready = await invoke("start_engine");
    dot.className = "dot on";
    label.textContent = ready ? "Whistle ready" : "Engine running";
  } catch (err) {
    dot.className = "dot";
    label.textContent = "Engine offline";
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

function applySettingsToUI() {
  $("#heroHotkey").textContent = fmtHotkey(settings.hotkey);
  $("#hotkeyBtn").textContent = fmtHotkey(settings.hotkey);
  $("#langSel").value = settings.language;
  $("#insertSel").value = settings.insert_mode;
  $("#autoIns").checked = settings.auto_insert;
  $("#soundTgl").checked = settings.sound;
}

$("#langSel").addEventListener("change", (e) => { settings.language = e.target.value; saveSettings(); });
$("#insertSel").addEventListener("change", (e) => { settings.insert_mode = e.target.value; saveSettings(); });
$("#autoIns").addEventListener("change", (e) => { settings.auto_insert = e.target.checked; saveSettings(); });
$("#soundTgl").addEventListener("change", (e) => { settings.sound = e.target.checked; saveSettings(); });

// hotkey capture
$("#hotkeyBtn").addEventListener("click", function () {
  const btn = this;
  btn.classList.add("listening");
  btn.textContent = "Press keys…";
  function onKey(e) {
    e.preventDefault();
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    const parts = [];
    if (e.metaKey || e.ctrlKey) parts.push("CmdOrCtrl");
    if (e.shiftKey) parts.push("Shift");
    if (e.altKey) parts.push("Alt");
    let key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    parts.push(key);
    settings.hotkey = parts.join("+");
    btn.classList.remove("listening");
    applySettingsToUI();
    saveSettings();
    toast("Hotkey saved — restart Sylph to apply");
    window.removeEventListener("keydown", onKey, true);
  }
  window.addEventListener("keydown", onKey, true);
});

// ── Live pill events (reflect dictations done via the floating pill) ─────────
listen("sylph://transcribed", () => { renderHistory(); });

// ── Boot ─────────────────────────────────────────────────────────────────────
(async function boot() {
  settings = await invoke("get_settings");
  applySettingsToUI();
  renderChips();
  initEngine();
})();
