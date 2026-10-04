// Sylph — scratchpad window.
// Shows the last transcript so it's never lost if no field was focused.
// Auto-dismisses after N seconds; hovering pauses the countdown.

const TAURI = !!window.__TAURI__;
const invoke = TAURI ? window.__TAURI__.core.invoke : async () => {};
const listen = TAURI ? window.__TAURI__.event.listen : async () => () => {};

const card = document.getElementById("card");
const txt = document.getElementById("txt");
const fill = document.getElementById("fill");
const copyBtn = document.getElementById("copy");
const copyLabel = document.getElementById("copyLabel");

let current = "";
let timer = null;
let seconds = 8;

function startCountdown() {
  clearTimeout(timer);
  // reset bar, then animate to 0 over `seconds`
  fill.style.transition = "none";
  fill.style.transform = "scaleX(1)";
  // force reflow so the transition restarts
  void fill.offsetWidth;
  fill.style.transition = `transform ${seconds}s linear`;
  fill.style.transform = "scaleX(0)";
  timer = setTimeout(dismiss, seconds * 1000);
}

function pauseCountdown() {
  clearTimeout(timer);
  const w = getComputedStyle(fill).transform;
  fill.style.transition = "none";
  fill.style.transform = w === "none" ? "scaleX(1)" : w;
}

function dismiss() {
  clearTimeout(timer);
  card.classList.remove("show");
  setTimeout(() => invoke("hide_scratch"), 220);
}

function show(text, secs) {
  current = text;
  seconds = secs || 8;
  txt.textContent = text;
  copyLabel.textContent = "Copy";
  card.classList.add("show");
  startCountdown();
}

copyBtn.addEventListener("click", async () => {
  try { await invoke("copy_text", { text: current }); }
  catch { try { await navigator.clipboard.writeText(current); } catch {} }
  copyLabel.textContent = "Copied ✓";
  clearTimeout(timer);
  setTimeout(dismiss, 900);
});

document.getElementById("close").addEventListener("click", dismiss);

// Keep it around while the user is reading / selecting.
card.addEventListener("mouseenter", pauseCountdown);
card.addEventListener("mouseleave", startCountdown);

listen("sylph://scratch", (e) => {
  const { text, seconds: secs } = e.payload || {};
  if (text) show(text, secs);
});
