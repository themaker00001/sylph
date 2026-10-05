// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Sylph — the native shell.
//!
//! Native-only responsibilities:
//!   * own a long-lived Python **Whistle** sidecar and speak its JSON protocol
//!   * a global trigger key (left Option by default) with BOTH Wispr-style
//!     gestures: double-tap to toggle, and press-and-hold to talk
//!   * insert transcribed text into whatever app the user is typing in
//!   * a transient **scratchpad** window so a transcript is never lost
//!   * persist settings + dictation history

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};

// ---------------------------------------------------------------------------
// Settings + history persistence
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct Settings {
    language: String,     // "auto" or an ISO code like "en"
    insert_mode: String,  // "paste" | "type"
    auto_insert: bool,    // paste automatically after transcription
    sound: bool,          // (reserved) play a cue on start/stop
    keywords: Vec<String>,// dictionary / biasing terms
    trigger: String,      // "option_left" | "option_right" | "control_left" | "command_left"
    invisible_pill: bool, // minimal, unobtrusive pill
    scratchpad: bool,     // show the transient scratchpad after dictation
    scratch_seconds: u32, // how long the scratchpad lingers
    theme: String,        // "system" | "light" | "dark"
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            language: "auto".into(),
            insert_mode: "paste".into(),
            auto_insert: true,
            sound: true,
            keywords: vec![],
            trigger: "option_left".into(),
            invisible_pill: false,
            scratchpad: true,
            scratch_seconds: 8,
            theme: "system".into(),
        }
    }
}

fn config_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Sylph")
}
fn settings_path() -> PathBuf { config_dir().join("settings.json") }
fn history_path() -> PathBuf { config_dir().join("history.json") }

fn load_settings() -> Settings {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
fn save_settings(s: &Settings) {
    let _ = std::fs::create_dir_all(config_dir());
    if let Ok(txt) = serde_json::to_string_pretty(s) {
        let _ = std::fs::write(settings_path(), txt);
    }
}

// ---------------------------------------------------------------------------
// Sidecar management
// ---------------------------------------------------------------------------

struct Sidecar {
    #[allow(dead_code)]
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<std::process::ChildStdout>,
    counter: u64,
    ready: bool,
}

#[derive(Default)]
struct AppState {
    sidecar: Mutex<Option<Sidecar>>,
    settings: Mutex<Settings>,
    engine: Mutex<Vec<String>>, // argv for launching the engine (resolved at startup)
}

/// Resolve how to launch the transcription engine, as an argv vector.
/// Preference: bundled frozen binary (shipped in the .app) → env overrides →
/// installer config → dev venv. The frozen binary needs no Python at all.
fn resolve_engine(app: &tauri::AppHandle) -> Vec<String> {
    // 1. frozen engine bundled inside the app (PyInstaller) — zero dependencies
    if let Ok(res) = app.path().resource_dir() {
        let frozen = res.join("resources/sylph-engine");
        if frozen.exists() {
            return vec![frozen.to_string_lossy().into_owned()];
        }
    }
    // 2. explicit overrides (dev / power users)
    if let Ok(e) = std::env::var("SYLPH_ENGINE") {
        return vec![e];
    }
    if let (Ok(p), Ok(s)) = (std::env::var("SYLPH_PYTHON"), std::env::var("SYLPH_SIDECAR")) {
        return vec![p, s];
    }
    // 3. installer config (may point at a frozen engine or python+sidecar)
    let cfg = config_dir().join("engine.json");
    if let Ok(txt) = std::fs::read_to_string(&cfg) {
        if let Ok(v) = serde_json::from_str::<Value>(&txt) {
            if let Some(e) = v.get("engine").and_then(|x| x.as_str()) {
                return vec![e.to_string()];
            }
            if let (Some(p), Some(s)) = (
                v.get("python").and_then(|x| x.as_str()),
                v.get("sidecar").and_then(|x| x.as_str()),
            ) {
                return vec![p.to_string(), s.to_string()];
            }
        }
    }
    // 4. dev fallback: a .venv next to the crate
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest.parent().unwrap_or(&manifest).to_path_buf();
    vec![
        root.join(".venv/bin/python").to_string_lossy().into_owned(),
        root.join("sidecar/server.py").to_string_lossy().into_owned(),
    ]
}

fn spawn_sidecar(state: &AppState) -> Result<(), String> {
    let mut guard = state.sidecar.lock().unwrap();
    if guard.is_some() { return Ok(()); }
    let argv = state.engine.lock().unwrap().clone();
    let (cmd, rest) = argv.split_first().ok_or("engine not configured")?;
    if cmd.contains('/') && !std::path::Path::new(cmd).exists() {
        return Err(format!("engine not found at {cmd}"));
    }
    let mut child = Command::new(cmd).args(rest)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
        .spawn().map_err(|e| format!("failed to spawn engine: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| format!("sidecar handshake failed: {e}"))?;
    let ready = serde_json::from_str::<Value>(&line)
        .map(|v| v.get("ready").and_then(|b| b.as_bool()).unwrap_or(false))
        .unwrap_or(false);
    *guard = Some(Sidecar { child, stdin, reader, counter: 0, ready });
    Ok(())
}

fn sidecar_request(state: &AppState, mut req: Value) -> Result<Value, String> {
    let mut guard = state.sidecar.lock().unwrap();
    let sc = guard.as_mut().ok_or("sidecar not started")?;
    sc.counter += 1;
    req["id"] = json!(sc.counter);
    let line = serde_json::to_string(&req).map_err(|e| e.to_string())? + "\n";
    sc.stdin.write_all(line.as_bytes()).map_err(|e| format!("write to sidecar: {e}"))?;
    sc.stdin.flush().ok();
    let mut resp = String::new();
    sc.reader.read_line(&mut resp).map_err(|e| format!("read from sidecar: {e}"))?;
    serde_json::from_str::<Value>(&resp).map_err(|e| format!("bad sidecar json: {e}"))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct TranscriptResult {
    text: String,
    language: Option<String>,
    ttft_ms: Option<f64>,
    decode_tps: Option<f64>,
}

#[tauri::command]
fn start_engine(state: State<AppState>) -> Result<bool, String> {
    spawn_sidecar(&state)?;
    Ok(state.sidecar.lock().unwrap().as_ref().map(|s| s.ready).unwrap_or(false))
}

#[tauri::command]
fn engine_ready(state: State<AppState>) -> bool {
    state.sidecar.lock().unwrap().as_ref().map(|s| s.ready).unwrap_or(false)
}

#[tauri::command]
fn transcribe(state: State<AppState>, wav_base64: String) -> Result<TranscriptResult, String> {
    spawn_sidecar(&state)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(wav_base64.as_bytes()).map_err(|e| format!("bad base64: {e}"))?;
    let tmp = std::env::temp_dir().join(format!("sylph_{}.wav", std::process::id()));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("write temp wav: {e}"))?;

    let settings = state.settings.lock().unwrap().clone();
    let language = if settings.language == "auto" { Value::Null } else { json!(settings.language) };

    let resp = sidecar_request(&state, json!({
        "cmd": "transcribe",
        "wav_path": tmp.to_string_lossy(),
        "language": language,
        "keywords": settings.keywords,
    }));
    let _ = std::fs::remove_file(&tmp);
    let resp = resp?;

    if !resp.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) {
        return Err(resp.get("error").and_then(|e| e.as_str()).unwrap_or("unknown sidecar error").to_string());
    }
    Ok(TranscriptResult {
        text: resp.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        language: resp.get("language").and_then(|t| t.as_str()).map(String::from),
        ttft_ms: resp.get("ttft_ms").and_then(|t| t.as_f64()),
        decode_tps: resp.get("decode_tps").and_then(|t| t.as_f64()),
    })
}

#[tauri::command]
fn insert_text(state: State<AppState>, text: String) -> Result<(), String> {
    if text.is_empty() { return Ok(()); }
    let mode = state.settings.lock().unwrap().insert_mode.clone();

    use enigo::{Direction, Enigo, Key, Keyboard, Settings as EnigoSettings};
    let mut enigo = Enigo::new(&EnigoSettings::default()).map_err(|e| e.to_string())?;

    if mode == "type" {
        enigo.text(&text).map_err(|e| e.to_string())?;
        return Ok(());
    }
    {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        cb.set_text(text).map_err(|e| e.to_string())?;
    }
    std::thread::sleep(Duration::from_millis(80));

    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    enigo.key(modifier, Direction::Press).map_err(|e| e.to_string())?;
    enigo.key(Key::Unicode('v'), Direction::Click).map_err(|e| e.to_string())?;
    enigo.key(modifier, Direction::Release).map_err(|e| e.to_string())?;
    Ok(())
}

/// Copy text to the clipboard without pasting (used by the scratchpad).
#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}

/// Is this exact build actually trusted for Accessibility right now?
/// (Non-prompting. For ad-hoc builds a stale System Settings toggle can read as
/// "on" while this returns false — the build's code identity changed.)
#[tauri::command]
fn accessibility_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        return macos_accessibility_client::accessibility::application_is_trusted();
    }
    #[allow(unreachable_code)]
    true
}

#[tauri::command]
fn open_accessibility_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn();
    }
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings { state.settings.lock().unwrap().clone() }

#[tauri::command]
fn update_settings(state: State<AppState>, settings: Settings) -> Result<(), String> {
    save_settings(&settings);
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
fn get_history() -> Value {
    std::fs::read_to_string(history_path()).ok()
        .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!([]))
}

#[tauri::command]
fn add_history(entry: Value) -> Result<(), String> {
    let _ = std::fs::create_dir_all(config_dir());
    let mut list: Vec<Value> = std::fs::read_to_string(history_path()).ok()
        .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    list.insert(0, entry);
    list.truncate(500);
    std::fs::write(history_path(), serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn clear_history() -> Result<(), String> { let _ = std::fs::write(history_path(), "[]"); Ok(()) }

#[tauri::command]
fn show_main(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); }
}

#[tauri::command]
fn hide_pill(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("pill") { let _ = w.hide(); }
}

#[tauri::command]
fn show_scratch(app: tauri::AppHandle, text: String, seconds: u32) {
    if let Some(w) = app.get_webview_window("scratch") {
        let _ = w.show();
        let _ = app.emit_to("scratch", "sylph://scratch", json!({ "text": text, "seconds": seconds }));
    }
}

#[tauri::command]
fn hide_scratch(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("scratch") { let _ = w.hide(); }
}

// ---------------------------------------------------------------------------
// Global trigger key: double-tap to toggle, hold to talk
// ---------------------------------------------------------------------------

fn dictate_start(app: &tauri::AppHandle) {
    if let Some(pill) = app.get_webview_window("pill") {
        let _ = pill.show();
    }
    let _ = app.emit_to("pill", "sylph://dictate-start", ());
}
fn dictate_stop(app: &tauri::AppHandle) {
    let _ = app.emit_to("pill", "sylph://dictate-stop", ());
}

/// Does a pressed key (its device_query debug name) match the configured
/// trigger? Friendly tokens map to the right platform name (macOS uses
/// "LOption"/"Command", Linux/Windows use "LAlt"/"LMeta"). A custom captured
/// key is stored as its raw debug name and matched exactly.
fn trigger_matches(logical: &str, key_name: &str) -> bool {
    let targets: &[&str] = match logical {
        "option_left" => &["LOption", "LAlt"],
        "option_right" => &["ROption", "RAlt"],
        "control_left" => &["LControl"],
        "control_right" => &["RControl"],
        "shift_left" => &["LShift"],
        "shift_right" => &["RShift"],
        "command" => &["Command", "LMeta", "RMeta", "Meta"],
        other => return other == key_name, // raw captured debug name
    };
    targets.contains(&key_name)
}

/// Poll global key state (no event tap → robust, no accessibility prompt, and
/// it can't crash the app). Implements both Wispr gestures: double-tap to
/// toggle, press-and-hold to talk. The trigger key is read live each loop, so
/// changing it in Settings applies instantly with no restart.
fn start_hotkey_listener(app: tauri::AppHandle) {
    use device_query::{DeviceQuery, DeviceState};

    const HOLD: Duration = Duration::from_millis(220);
    const TAP_MAX: Duration = Duration::from_millis(300);
    const DOUBLE: Duration = Duration::from_millis(450);

    std::thread::spawn(move || {
        // Accessibility permission, without spamming prompts. device_query's
        // checked_new()/new() call the *prompting* API internally, so polling
        // them re-prompts forever (the "keeps asking" bug). Instead: show the
        // prompt exactly ONCE, then poll the non-prompting check, which reflects
        // the grant live (no restart). If the grant never registers, the app is
        // likely running translocated — installing to /Applications fixes that.
        #[cfg(target_os = "macos")]
        {
            use macos_accessibility_client::accessibility::{
                application_is_trusted, application_is_trusted_with_prompt,
            };
            if !application_is_trusted() {
                application_is_trusted_with_prompt();
                while !application_is_trusted() {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
        }
        let ds = DeviceState::new();
        let mut down = false;
        let mut down_at = Instant::now();
        let mut other_key = false;
        let mut hold_active = false;
        let mut recording = false;
        let mut last_tap: Option<Instant> = None;

        loop {
            let trig = {
                let st = app.state::<AppState>();
                let g = st.settings.lock().unwrap();
                g.trigger.clone()
            };
            let keys = ds.get_keys();
            let is_down = keys.iter().any(|k| trigger_matches(&trig, &format!("{:?}", k)));
            let now = Instant::now();

            if is_down {
                if !down {
                    down = true;
                    down_at = now;
                    other_key = false;
                    hold_active = false;
                }
                // any other key held → not a clean gesture (e.g. Option+E)
                if keys.iter().any(|k| !trigger_matches(&trig, &format!("{:?}", k))) {
                    other_key = true;
                }
                if !hold_active && !recording && !other_key && now.duration_since(down_at) >= HOLD {
                    recording = true;
                    hold_active = true;
                    dictate_start(&app);
                }
            } else if down {
                down = false;
                let held = now.duration_since(down_at);
                if hold_active {
                    hold_active = false;
                    recording = false;
                    last_tap = None;
                    dictate_stop(&app);
                } else if !other_key && held < TAP_MAX {
                    let is_double = last_tap.map(|t| now.duration_since(t) < DOUBLE).unwrap_or(false);
                    if is_double {
                        last_tap = None;
                        if recording {
                            recording = false;
                            dictate_stop(&app);
                        } else {
                            recording = true;
                            dictate_start(&app);
                        }
                    } else {
                        last_tap = Some(now);
                    }
                } else {
                    last_tap = None;
                }
            }

            std::thread::sleep(Duration::from_millis(12));
        }
    });
}

/// Capture the next key the user presses, for a fully custom trigger.
/// Returns the device_query debug name (e.g. "RControl", "F13", "RMeta").
#[tauri::command]
async fn capture_trigger() -> Option<String> {
    // Run the blocking poll off the main thread so the UI never freezes.
    tauri::async_runtime::spawn_blocking(capture_next_key_blocking)
        .await
        .ok()
        .flatten()
}

fn capture_next_key_blocking() -> Option<String> {
    use device_query::{DeviceQuery, DeviceState};
    // Use the NON-prompting trust check. checked_new()/new() use the *prompting*
    // API, which can report "not trusted" even when it is — that made capture
    // silently return nothing. If truly not trusted, bail so the UI can say so.
    #[cfg(target_os = "macos")]
    {
        if !macos_accessibility_client::accessibility::application_is_trusted() {
            return None;
        }
    }
    let ds = DeviceState::new();
    // Wait for a clean slate so we don't grab a key that's already held (max 2s).
    let start = Instant::now();
    while !ds.get_keys().is_empty() && start.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(15));
    }
    // Capture the next key pressed — generous window for reaction time.
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(10) {
        if let Some(k) = ds.get_keys().into_iter().next() {
            return Some(format!("{:?}", k));
        }
        std::thread::sleep(Duration::from_millis(12));
    }
    None
}

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

fn main() {
    let settings = load_settings();

    tauri::Builder::default()
        .manage(AppState {
            sidecar: Mutex::new(None),
            settings: Mutex::new(settings),
            engine: Mutex::new(Vec::new()),
        })
        .invoke_handler(tauri::generate_handler![
            start_engine, engine_ready, transcribe, insert_text, copy_text,
            get_settings, update_settings, get_history, add_history, clear_history,
            show_main, hide_pill, show_scratch, hide_scratch, capture_trigger,
            accessibility_trusted, open_accessibility_settings,
        ])
        .setup(move |app| {
            start_hotkey_listener(app.handle().clone());
            // Resolve the engine command once (prefers the bundled frozen binary).
            {
                let argv = resolve_engine(app.handle());
                *app.state::<AppState>().engine.lock().unwrap() = argv;
            }

            // Position the pill + scratchpad at the bottom-center of the screen.
            if let Some(pill) = app.get_webview_window("pill") {
                if let Ok(Some(m)) = pill.primary_monitor() {
                    let size = m.size();
                    let scale = m.scale_factor();
                    let x = (size.width as f64 - 280.0 * scale) / 2.0;
                    let y = size.height as f64 - 140.0 * scale;
                    let _ = pill.set_position(tauri::PhysicalPosition::new(x, y));
                }
            }
            if let Some(scr) = app.get_webview_window("scratch") {
                if let Ok(Some(m)) = scr.primary_monitor() {
                    let size = m.size();
                    let scale = m.scale_factor();
                    let x = (size.width as f64 - 420.0 * scale) / 2.0;
                    let y = size.height as f64 - 250.0 * scale;
                    let _ = scr.set_position(tauri::PhysicalPosition::new(x, y));
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Sylph");
}
