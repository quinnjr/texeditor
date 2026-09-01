// Tauri backend entry point.
// Commands are registered in the invoke_handler below. OWNER: rust agent.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Engines we know how to probe / invoke.
///
/// All of these are TeX-family binaries that accept the exact same
/// `-interaction` / `-halt-on-error` / `-output-directory` flags, which is what
/// `run_engine_once` below relies on. Deliberately excludes `tectonic`: it is
/// detectable via `--version` but rejects every one of those flags (it wants
/// `--outdir` and drives its own rerun loop), so advertising it in the engine
/// picker would only hand the user a compile that always fails.
const KNOWN_ENGINES: [&str; 3] = ["pdflatex", "xelatex", "lualatex"];

/// Kill a compiler pass if it hasn't finished within this many seconds.
const COMPILE_TIMEOUT_SECS: u64 = 60;

/// Keep only the last N characters of the combined log we hand back to the UI.
const LOG_TAIL_CHARS: usize = 8000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    ok: bool,
    pdf_base64: Option<String>,
    log: String,
}

#[derive(Serialize)]
pub struct FileContent {
    path: String,
    content: String,
}

/// Keep only the last `max_chars` characters of `s`, preserving char boundaries.
fn tail(s: &str, max_chars: usize) -> String {
    let char_count = s.chars().count();
    if char_count <= max_chars {
        s.to_string()
    } else {
        let skip = char_count - max_chars;
        s.chars().skip(skip).collect()
    }
}

/// Run `engine -interaction=nonstopmode -halt-on-error -output-directory=<dir> main.tex`
/// once inside `dir`, with a hard timeout. Never panics: every failure mode is folded
/// into `Ok((false, log))` except a fatal spawn failure which is returned as `Err`.
fn run_engine_once(engine: &str, dir: &Path) -> Result<(bool, String), String> {
    let mut child = Command::new(engine)
        .arg("-interaction=nonstopmode")
        .arg("-halt-on-error")
        .arg(format!("-output-directory={}", dir.display()))
        .arg("main.tex")
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start `{engine}`: {e}"))?;

    // Drain stdout/stderr concurrently on their own threads so a full pipe buffer
    // can never stall the process while we're busy polling try_wait().
    let stdout_handle = child.stdout.take().map(|mut out| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = out.read_to_end(&mut buf);
            buf
        })
    });
    let stderr_handle = child.stderr.take().map(|mut err| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = err.read_to_end(&mut buf);
            buf
        })
    });

    let start = Instant::now();
    let mut timed_out = false;
    let wait_result = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {
                if start.elapsed() > Duration::from_secs(COMPILE_TIMEOUT_SECS) {
                    timed_out = true;
                    let _ = child.kill();
                    break child.wait();
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => break Err(e),
        }
    };

    let stdout_buf = stdout_handle.and_then(|h| h.join().ok()).unwrap_or_default();
    let stderr_buf = stderr_handle.and_then(|h| h.join().ok()).unwrap_or_default();

    let mut combined = String::from_utf8_lossy(&stdout_buf).into_owned();
    if !stderr_buf.is_empty() {
        combined.push('\n');
        combined.push_str(&String::from_utf8_lossy(&stderr_buf));
    }

    match wait_result {
        Ok(status) => {
            if timed_out {
                combined.push_str(&format!(
                    "\n[`{engine}` timed out after {COMPILE_TIMEOUT_SECS}s and was killed]"
                ));
                Ok((false, combined))
            } else {
                Ok((status.success(), combined))
            }
        }
        Err(e) => {
            combined.push_str(&format!("\nfailed to wait on `{engine}`: {e}"));
            Ok((false, combined))
        }
    }
}

// `(async)` on a *synchronous* fn is what keeps the window alive during a build.
// Without it Tauri picks `ExecutionContext::Blocking` and runs the body inline in
// the IPC handler — i.e. on the GTK main thread — so the two engine passes (up to
// 2 x COMPILE_TIMEOUT_SECS of try_wait/sleep polling) would freeze the entire UI:
// no spinner, no repaint, no draggable divider. With `(async)` the body is moved
// into the future handed to `respond_async_serialized`, which is spawned on the
// async runtime, and the main loop keeps iterating.
#[tauri::command(async)]
fn compile_latex(source: String, engine: String) -> CompileResult {
    if !KNOWN_ENGINES.contains(&engine.as_str()) {
        return CompileResult {
            ok: false,
            pdf_base64: None,
            log: format!(
                "unsupported engine: `{engine}` (expected one of {})",
                KNOWN_ENGINES.join(", ")
            ),
        };
    }

    let dir = match tempfile::Builder::new().prefix("tex-viewer-").tempdir() {
        Ok(d) => d,
        Err(e) => {
            return CompileResult {
                ok: false,
                pdf_base64: None,
                log: format!("failed to create a temp directory: {e}"),
            }
        }
    };

    let tex_path = dir.path().join("main.tex");
    if let Err(e) = std::fs::write(&tex_path, source.as_bytes()) {
        return CompileResult {
            ok: false,
            pdf_base64: None,
            log: format!("failed to write main.tex: {e}"),
        };
    }

    let mut full_log = String::new();
    let mut last_ok = false;

    // Run twice so cross-references / the table of contents resolve.
    for pass in 1..=2 {
        match run_engine_once(&engine, dir.path()) {
            Ok((success, output)) => {
                full_log.push_str(&format!("--- pass {pass} ({engine}) ---\n"));
                full_log.push_str(&output);
                full_log.push('\n');
                last_ok = success;
                if !success {
                    break;
                }
            }
            Err(e) => {
                full_log.push_str(&format!("--- pass {pass} ({engine}) ---\n{e}\n"));
                last_ok = false;
                break;
            }
        }
    }

    // main.log carries diagnostics even beyond what's echoed to stdout/stderr.
    let log_file_path = dir.path().join("main.log");
    if let Ok(bytes) = std::fs::read(&log_file_path) {
        full_log.push_str("\n--- main.log ---\n");
        full_log.push_str(&String::from_utf8_lossy(&bytes));
    }

    let truncated_log = tail(&full_log, LOG_TAIL_CHARS);

    if !last_ok {
        return CompileResult {
            ok: false,
            pdf_base64: None,
            log: truncated_log,
        };
    }

    let pdf_path = dir.path().join("main.pdf");
    match std::fs::read(&pdf_path) {
        Ok(bytes) => CompileResult {
            ok: true,
            pdf_base64: Some(STANDARD.encode(bytes)),
            log: truncated_log,
        },
        Err(e) => CompileResult {
            ok: false,
            pdf_base64: None,
            log: format!("{truncated_log}\nfailed to read main.pdf: {e}"),
        },
    }
}

// Also `(async)`: this spawns three `--version` probes and is called from
// App.svelte's onMount, so running it inline on the main thread would stall the
// first paint behind three process spawns.
#[tauri::command(async)]
fn check_engines() -> Vec<String> {
    KNOWN_ENGINES
        .iter()
        .filter(|engine| {
            Command::new(engine)
                .arg("--version")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        })
        .map(|engine| engine.to_string())
        .collect()
}

// MUST be `(async)`. `blocking_pick_file` sends the dialog request to the main
// thread and then parks on `rx.recv()`; if the command itself is running on the
// main thread that recv can never be satisfied — rfd's GTK backend needs the
// default GMainContext the parked thread is holding — and the whole app
// deadlocks with no dialog on screen. tauri-plugin-dialog documents the blocking
// APIs as "should *NOT* be used when running on the main thread" for exactly
// this reason. Off the main thread they are correct as written.
#[tauri::command(async)]
fn open_file(app: AppHandle) -> Result<Option<FileContent>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("LaTeX", &["tex"])
        .blocking_pick_file();

    let picked = match picked {
        Some(p) => p,
        None => return Ok(None),
    };

    let path_buf: PathBuf = picked
        .into_path()
        .map_err(|e| format!("failed to resolve picked file path: {e}"))?;

    let content = std::fs::read_to_string(&path_buf)
        .map_err(|e| format!("failed to read {}: {e}", path_buf.display()))?;

    Ok(Some(FileContent {
        path: path_buf.display().to_string(),
        content,
    }))
}

// `(async)` for the same reason as `open_file`: the untitled-document path calls
// `blocking_save_file`, which deadlocks if it runs on the main thread.
#[tauri::command(async)]
fn save_file(app: AppHandle, path: Option<String>, content: String) -> Result<Option<String>, String> {
    let target_path: Option<PathBuf> = match path {
        Some(p) => Some(PathBuf::from(p)),
        None => {
            let picked = app
                .dialog()
                .file()
                .add_filter("LaTeX", &["tex"])
                .blocking_save_file();
            match picked {
                Some(fp) => Some(
                    fp.into_path()
                        .map_err(|e| format!("failed to resolve save path: {e}"))?,
                ),
                None => None,
            }
        }
    };

    let target_path = match target_path {
        Some(p) => p,
        None => return Ok(None),
    };

    std::fs::write(&target_path, content)
        .map_err(|e| format!("failed to write {}: {e}", target_path.display()))?;

    Ok(Some(target_path.display().to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            compile_latex,
            check_engines,
            open_file,
            save_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
