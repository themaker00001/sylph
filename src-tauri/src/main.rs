// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Sylph — the native shell.
//!
//! Responsibilities that only native code can do:
//!   * own a long-lived Python **Whistle** sidecar and speak its JSON protocol
//!   * register a global hotkey that works while any app is focused
//!   * insert transcribed text into whatever app the user is typing in
//!   * persist settings + dictation history
//!
//! Audio capture lives in the webview (getUserMedia), which hands us a 16 kHz
//! mono WAV as base64; we transcribe it and paste the result.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

// ---------------------------------------------------------------------------
// Settings + history persistence
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Settings {
    hotkey: String,
    language: String,     // "auto" or an ISO code like "en"
    insert_mode: String,  // "paste" | "type"
    auto_insert: bool,    // paste automatically after transcription
    sound: bool,          // (reserved) play a cue on start/stop
    keywords: Vec<String>, // dictionary / biasing terms
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            hotkey: "CmdOrCtrl+Shift+Space".into(),
            language: "auto".into(),
            insert_mode: "paste".into(),
            auto_insert: true,
            sound: true,
            keywords: vec![],
        }
    }
}

fn config_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("Sylph")
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}
fn history_path() -> PathBuf {
    config_dir().join("history.json")
}

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
}

/// Resolve the python interpreter + sidecar script.
/// Dev: relative to the crate. Override with SYLPH_PYTHON / SYLPH_SIDECAR.
fn resolve_sidecar() -> (PathBuf, PathBuf) {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest.parent().unwrap_or(&manifest).to_path_buf();

    let py = std::env::var("SYLPH_PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root.join(".venv/bin/python"));
    let script = std::env::var("SYLPH_SIDECAR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root.join("sidecar/server.py"));
    (py, script)
}

fn spawn_sidecar(state: &AppState) -> Result<(), String> {
    let mut guard = state.sidecar.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }
    let (py, script) = resolve_sidecar();
    if !py.exists() {
        return Err(format!(
            "python venv not found at {}. Run ./scripts/setup.sh first.",
            py.display()
        ));
    }
    let mut child = Command::new(&py)
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut reader = BufReader::new(stdout);

    // Wait for the readiness line (model loads here; may download on first run).
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("sidecar handshake failed: {e}"))?;
    let ready = serde_json::from_str::<Value>(&line)
        .map(|v| v.get("ready").and_then(|b| b.as_bool()).unwrap_or(false))
        .unwrap_or(false);

    *guard = Some(Sidecar {
        child,
        stdin,
        reader,
        counter: 0,
        ready,
    });
    Ok(())
}

fn sidecar_request(state: &AppState, mut req: Value) -> Result<Value, String> {
    let mut guard = state.sidecar.lock().unwrap();
    let sc = guard.as_mut().ok_or("sidecar not started")?;
    sc.counter += 1;
    req["id"] = json!(sc.counter);
    let line = serde_json::to_string(&req).map_err(|e| e.to_string())? + "\n";
    sc.stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("write to sidecar: {e}"))?;
    sc.stdin.flush().ok();

    let mut resp = String::new();
    sc.reader
        .read_line(&mut resp)
        .map_err(|e| format!("read from sidecar: {e}"))?;
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
    let guard = state.sidecar.lock().unwrap();
    Ok(guard.as_ref().map(|s| s.ready).unwrap_or(false))
}

#[tauri::command]
fn engine_ready(state: State<AppState>) -> bool {
    state
        .sidecar
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.ready)
        .unwrap_or(false)
}

/// Transcribe a base64-encoded 16 kHz mono WAV.
#[tauri::command]
fn transcribe(state: State<AppState>, wav_base64: String) -> Result<TranscriptResult, String> {
    // Make sure the engine is up (lazy start).
    spawn_sidecar(&state)?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(wav_base64.as_bytes())
        .map_err(|e| format!("bad base64: {e}"))?;

    let tmp = std::env::temp_dir().join(format!("sylph_{}.wav", std::process::id()));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("write temp wav: {e}"))?;

    let settings = state.settings.lock().unwrap().clone();
    let language = if settings.language == "auto" {
        Value::Null
    } else {
        json!(settings.language)
    };

    let resp = sidecar_request(
        &state,
        json!({
            "cmd": "transcribe",
            "wav_path": tmp.to_string_lossy(),
            "language": language,
            "keywords": settings.keywords,
        }),
    );
    let _ = std::fs::remove_file(&tmp);
    let resp = resp?;

    if !resp.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) {
        return Err(resp
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("unknown sidecar error")
            .to_string());
    }

    Ok(TranscriptResult {
        text: resp.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        language: resp.get("language").and_then(|t| t.as_str()).map(String::from),
        ttft_ms: resp.get("ttft_ms").and_then(|t| t.as_f64()),
        decode_tps: resp.get("decode_tps").and_then(|t| t.as_f64()),
    })
}

/// Insert text into the currently focused application.
#[tauri::command]
fn insert_text(state: State<AppState>, text: String) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    let mode = state.settings.lock().unwrap().insert_mode.clone();

    use enigo::{Direction, Enigo, Key, Keyboard, Settings as EnigoSettings};
    let mut enigo = Enigo::new(&EnigoSettings::default()).map_err(|e| e.to_string())?;

    if mode == "type" {
        enigo.text(&text).map_err(|e| e.to_string())?;
        return Ok(());
    }

    // paste mode: put text on the clipboard, then send the paste shortcut.
    {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        cb.set_text(text).map_err(|e| e.to_string())?;
    }
    // Give the clipboard a beat to settle before pasting.
    std::thread::sleep(std::time::Duration::from_millis(80));

    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    enigo.key(modifier, Direction::Press).map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo.key(modifier, Direction::Release).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn update_settings(state: State<AppState>, settings: Settings) -> Result<(), String> {
    save_settings(&settings);
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
fn get_history() -> Value {
    std::fs::read_to_string(history_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!([]))
}

#[tauri::command]
fn add_history(entry: Value) -> Result<(), String> {
    let _ = std::fs::create_dir_all(config_dir());
    let mut list: Vec<Value> = std::fs::read_to_string(history_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    list.insert(0, entry);
    list.truncate(500);
    std::fs::write(
        history_path(),
        serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn clear_history() -> Result<(), String> {
    let _ = std::fs::write(history_path(), "[]");
    Ok(())
}

#[tauri::command]
fn show_main(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn hide_pill(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("pill") {
        let _ = w.hide();
    }
}

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

fn toggle_dictation(app: &tauri::AppHandle) {
    if let Some(pill) = app.get_webview_window("pill") {
        let _ = pill.show();
        let _ = pill.set_focus();
        let _ = app.emit_to("pill", "sylph://toggle", ());
    }
}

fn main() {
    let settings = load_settings();
    let hotkey = settings.hotkey.clone();

    tauri::Builder::default()
        .manage(AppState {
            sidecar: Mutex::new(None),
            settings: Mutex::new(settings),
        })
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_dictation(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            start_engine,
            engine_ready,
            transcribe,
            insert_text,
            get_settings,
            update_settings,
            get_history,
            add_history,
            clear_history,
            show_main,
            hide_pill,
        ])
        .setup(move |app| {
            // Register the global hotkey.
            if let Err(e) = app.global_shortcut().register(hotkey.as_str()) {
                eprintln!("[sylph] could not register hotkey {hotkey}: {e}");
            }

            // Position the pill at the bottom-center of the primary monitor.
            if let Some(pill) = app.get_webview_window("pill") {
                if let Ok(Some(monitor)) = pill.primary_monitor() {
                    let size = monitor.size();
                    let scale = monitor.scale_factor();
                    let w = 260.0 * scale;
                    let x = (size.width as f64 - w) / 2.0;
                    let y = size.height as f64 - 140.0 * scale;
                    let _ = pill.set_position(tauri::PhysicalPosition::new(x, y));
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Sylph");
}
