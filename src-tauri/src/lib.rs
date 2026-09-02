// Tauri backend entry point.
// Commands are registered in the invoke_handler below. OWNER: rust agent.

mod sandbox;

use serde::Serialize;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Engines we know how to probe / invoke.
///
/// `pdflatex` / `xelatex` / `lualatex` are TeX-family binaries taking the same
/// `-interaction` / `-halt-on-error` / `-output-directory` flags. `tectonic`
/// takes none of those — it wants `--outdir`, drives its own rerun loop and
/// resolves its own bibliography — so it gets a separate arm in
/// [`EngineKind`] rather than being pushed through the TeX-family path.
///
/// Tectonic is also the engine we *ship*: a bundled sidecar means a fresh
/// install can produce a PDF without the user first installing a TeX
/// distribution. It is listed last so a system TeX, which needs no network and
/// carries the user's own packages, is preferred when one is present.
const KNOWN_ENGINES: [&str; 4] = ["pdflatex", "xelatex", "lualatex", "tectonic"];

/// How an engine wants to be driven.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum EngineKind {
    /// `-interaction=nonstopmode -halt-on-error -output-directory=…`, driven
    /// through our own multi-pass + bibliography loop.
    TexFamily,
    /// One invocation that reruns internally and resolves its own bibliography.
    Tectonic,
}

impl EngineKind {
    fn of(engine: &str) -> Self {
        if engine == "tectonic" {
            EngineKind::Tectonic
        } else {
            EngineKind::TexFamily
        }
    }

    /// Tectonic reruns internally, so driving it through our pass loop would
    /// typeset the document up to `MAX_PASSES` times over.
    fn max_passes(self) -> u32 {
        match self {
            EngineKind::TexFamily => MAX_PASSES,
            EngineKind::Tectonic => 1,
        }
    }

    /// Tectonic runs bibtex/biber itself as part of a single invocation.
    fn drives_own_bibliography(self) -> bool {
        self == EngineKind::Tectonic
    }
}

/// Kill a single engine/bibliography pass if it hasn't finished within this long.
const PASS_TIMEOUT: Duration = Duration::from_secs(60);

/// Hard ceiling on one `compile_latex` call, across *all* of its passes. Without
/// this, `PASS_TIMEOUT * MAX_PASSES` would be the real bound.
const COMPILE_BUDGET: Duration = Duration::from_secs(150);

/// How long to wait for a killed process to actually die before abandoning it to
/// a detached reaper thread. Keeps `run_bounded` a genuine bound: a process
/// wedged in uninterruptible sleep cannot hold the caller hostage.
const KILL_GRACE: Duration = Duration::from_secs(5);

/// How long to wait for the stdout/stderr readers once the process is gone.
const PIPE_DRAIN_GRACE: Duration = Duration::from_secs(5);

/// Bound on a single `--version` probe, so a hung engine cannot stall startup.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Upper bound on engine passes. LaTeX converges in two for cross-references and
/// three with a bibliography; the extra headroom covers `\tableofcontents` plus
/// `\cite` in the same document.
const MAX_PASSES: u32 = 5;

/// Keep only the last N characters of the combined log we hand back to the UI.
const LOG_TAIL_CHARS: usize = 8000;

/// Extensions `save_file` will write to when the caller supplies a path.
///
/// The command is reachable from the webview, so "whatever path you name" is not
/// an acceptable contract — a compromised or buggy frontend could otherwise
/// truncate `~/.ssh/authorized_keys`. This is the set a LaTeX editor has any
/// business writing.
const SAVABLE_EXTENSIONS: &[&str] = &[
    "tex", "ltx", "sty", "cls", "clo", "def", "cfg", "bib", "bbl", "bst", "dtx", "ins", "tikz",
    "txt", "md",
];

/// Path-list separator kpathsea expects in `TEXINPUTS` and friends.
const KPSE_SEP: char = if cfg!(windows) { ';' } else { ':' };

/// Result of one `compile_latex` run.
///
/// This crosses the IPC boundary hand-framed rather than as JSON — see
/// `encode_compile_response` — because a base64 round-trip of a multi-megabyte
/// PDF is a real cost on both ends (encode here, `atob` + a per-byte copy on
/// the frontend) for no benefit over handing over the bytes directly.
pub struct CompileResult {
    ok: bool,
    pdf_bytes: Option<Vec<u8>>,
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

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

/// Everything we learned from running one child process.
struct ProcRun {
    success: bool,
    timed_out: bool,
    output: String,
    /// Set when the child could not be confined; worth telling the user about,
    /// because it means an untrusted document ran with the app's own rights.
    sandbox_warning: Option<String>,
}

/// Find `name` on `PATH` and return its absolute path.
///
/// Resolving up front rather than letting `execvp` do it means the sandbox can
/// grant execute access to exactly the directory the engine lives in, which is
/// what makes a TeX Live installed under `$HOME` work.
fn resolve_program(name: &str) -> Option<PathBuf> {
    // The bundled engine sits next to the app executable (Tauri drops
    // `externalBin` sidecars there with the target triple stripped). Preferring
    // it for `tectonic` specifically means an installed app never depends on
    // the user happening to have Tectonic on PATH, while a system pdflatex is
    // still found the normal way.
    if name == "tectonic" {
        if let Some(bundled) = bundled_sidecar(BUNDLED_ENGINE) {
            return Some(bundled);
        }
    }

    let as_path = Path::new(name);
    if as_path.components().count() > 1 {
        return as_path.is_file().then(|| as_path.to_path_buf());
    }

    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var).find_map(|dir| {
        if dir.as_os_str().is_empty() {
            return None;
        }
        let direct = dir.join(name);
        if is_executable(&direct) {
            return Some(direct);
        }
        if cfg!(windows) {
            let exe = dir.join(format!("{name}.exe"));
            if is_executable(&exe) {
                return Some(exe);
            }
        }
        None
    })
}

/// Name of the Tectonic build we ship. Namespaced because sidecars are
/// installed into `/usr/bin` on Linux, where a plain `tectonic` would collide
/// with the distribution's own package.
const BUNDLED_ENGINE: &str = "tex-viewer-tectonic";

/// Path to a sidecar binary shipped beside the app executable, if it exists.
fn bundled_sidecar(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = if cfg!(windows) {
        dir.join(format!("{name}.exe"))
    } else {
        dir.join(name)
    };
    is_executable(&candidate).then_some(candidate)
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Spawn `cmd`, applying `policy` to the process if one is given.
///
/// Landlock domains are per-thread and inherited across `fork`, so the child is
/// spawned from a short-lived thread that confines *itself* first. Doing it that
/// way (rather than in a `pre_exec` hook) keeps every allocation and every path
/// lookup on the safe side of `fork`, and leaves the calling worker thread with
/// its normal rights so it can still read the resulting PDF.
fn spawn_confined(
    mut cmd: Command,
    policy: Option<&sandbox::Policy>,
) -> std::io::Result<(Child, Option<String>)> {
    let Some(policy) = policy else {
        return cmd.spawn().map(|child| (child, None));
    };

    let cmd = &mut cmd;
    std::thread::scope(|scope| {
        scope
            .spawn(move || {
                let warning = sandbox::confine_current_thread(policy)
                    .warning()
                    .map(str::to_string);
                cmd.spawn().map(|child| (child, warning))
            })
            .join()
            .unwrap_or_else(|_| {
                Err(std::io::Error::other("sandbox thread panicked while spawning"))
            })
    })
}

/// Read a pipe on its own thread, forwarding each chunk over a channel.
///
/// A channel rather than a `JoinHandle` so the reader can be *abandoned*: a
/// grandchild that inherits the write end keeps the pipe open after the child
/// itself exits, and `read_to_end` would then never return. Chunks rather than
/// one final buffer for the same reason — whatever the process managed to say
/// before that happened is still worth showing.
fn drain(pipe: Option<impl Read + Send + 'static>) -> Option<mpsc::Receiver<Vec<u8>>> {
    let mut pipe = pipe?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if tx.send(buf[..read].to_vec()).is_err() {
                        // Nobody is listening any more.
                        break;
                    }
                }
            }
        }
    });
    Some(rx)
}

/// Accumulate everything a [`drain`] reader has produced, up to `deadline`.
///
/// Returns as soon as the pipe reaches EOF (the sender drops), so the deadline
/// only bites when the write end is still held open by something we no longer
/// care about.
fn collect_until(rx: &mpsc::Receiver<Vec<u8>>, deadline: Instant) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match rx.recv_timeout(remaining) {
            Ok(chunk) => out.extend_from_slice(&chunk),
            // Disconnected (the normal EOF path) or timed out.
            Err(_) => break,
        }
    }
    out
}

/// Outcome of waiting for a child within a bound.
enum Waited {
    Exited(ExitStatus),
    /// Killed after `timeout`, and reaped.
    Killed,
    /// Killed after `timeout` but still not reaped within `KILL_GRACE`; the
    /// caller must hand the `Child` to a detached reaper.
    Abandoned,
    Failed(std::io::Error),
}

/// Poll `child` until it exits, `timeout` elapses, or waiting fails.
///
/// The previous implementation followed `kill()` with a bare `wait()`, which is
/// unbounded — a process that ignores SIGKILL because it is stuck in the kernel
/// pinned the caller indefinitely, so the "timeout" was not one. Here the
/// post-kill reap is bounded too, and a child that survives both is walked away
/// from rather than waited on.
fn wait_bounded(child: &mut Child, timeout: Duration) -> Waited {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Waited::Exited(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Waited::Failed(e),
        }
    }

    let _ = child.kill();
    let reap_deadline = Instant::now() + KILL_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Waited::Killed,
            Ok(None) => {
                if Instant::now() >= reap_deadline {
                    return Waited::Abandoned;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return Waited::Abandoned,
        }
    }
}

/// Run `cmd` to completion under a hard time bound, capturing stdout+stderr.
///
/// Every failure mode short of "could not spawn at all" is folded into an
/// unsuccessful `ProcRun` rather than an error, so a compile always has a log to
/// show.
fn run_bounded(
    mut cmd: Command,
    timeout: Duration,
    policy: Option<&sandbox::Policy>,
) -> std::io::Result<ProcRun> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let (mut child, sandbox_warning) = spawn_confined(cmd, policy)?;

    // Drain both pipes concurrently so a full pipe buffer can never stall the
    // process while we are polling try_wait().
    let stdout_rx = drain(child.stdout.take());
    let stderr_rx = drain(child.stderr.take());

    let waited = wait_bounded(&mut child, timeout);
    if matches!(waited, Waited::Abandoned) {
        // Detached reaper: keeps the process table clean without blocking us.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }

    // One shared deadline for both pipes, so the whole drain is bounded by
    // PIPE_DRAIN_GRACE rather than by twice it.
    let drain_deadline = Instant::now() + PIPE_DRAIN_GRACE;
    let mut output = String::new();
    for rx in [stdout_rx, stderr_rx].into_iter().flatten() {
        let buf = collect_until(&rx, drain_deadline);
        if !buf.is_empty() {
            if !output.is_empty() && !output.ends_with('\n') {
                output.push('\n');
            }
            output.push_str(&String::from_utf8_lossy(&buf));
        }
    }

    let (success, timed_out) = match waited {
        Waited::Exited(status) => (status.success(), false),
        Waited::Killed | Waited::Abandoned => (false, true),
        Waited::Failed(e) => {
            output.push_str(&format!("\nfailed to wait on the child process: {e}\n"));
            (false, false)
        }
    };

    Ok(ProcRun {
        success,
        timed_out,
        output,
        sandbox_warning,
    })
}

/// Run `program args...` with a bound and return its stdout on success.
///
/// Used for the `kpsewhich` query that tells the sandbox where the TeX trees
/// are; `pub(crate)` because `sandbox` calls it.
pub(crate) fn run_capture(program: &str, args: &[String], timeout: Duration) -> Option<String> {
    let binary = resolve_program(program)?;
    let mut cmd = Command::new(binary);
    cmd.args(args);
    let run = run_bounded(cmd, timeout, None).ok()?;
    run.success.then_some(run.output)
}

// ---------------------------------------------------------------------------
// LaTeX compilation
// ---------------------------------------------------------------------------

/// Environment shared by every process in one compile.
///
/// `openin_any`/`openout_any` are the historical kpathsea controls on reading
/// and writing outside the current tree. `openin_any` is a no-op on TeX Live
/// 2026 and later (upstream declared it one), so it is *not* what stops a
/// document from reading `/etc/passwd` — `sandbox` is. It is still set because
/// it is a genuine control on every earlier TeX Live and on MiKTeX.
fn compile_env(doc_dir: Option<&Path>) -> Vec<(String, String)> {
    let mut env = vec![
        ("openin_any".to_string(), "p".to_string()),
        ("openout_any".to_string(), "p".to_string()),
        ("shell_escape".to_string(), "f".to_string()),
    ];

    if let Some(dir) = doc_dir {
        // A leading `.` keeps the scratch directory first (that is where
        // main.tex and the generated .aux/.bbl live) and the trailing separator
        // is kpathsea's "and then the built-in default paths".
        let search = format!(".{KPSE_SEP}{}{KPSE_SEP}", dir.display());
        for var in ["TEXINPUTS", "BIBINPUTS", "BSTINPUTS"] {
            env.push((var.to_string(), search.clone()));
        }
    }

    env
}

/// One `engine main.tex` pass in `work_dir`.
fn run_engine_pass(
    engine_bin: &Path,
    kind: EngineKind,
    work_dir: &Path,
    env: &[(String, String)],
    policy: &sandbox::Policy,
    timeout: Duration,
) -> std::io::Result<ProcRun> {
    let mut cmd = Command::new(engine_bin);
    match kind {
        EngineKind::TexFamily => {
            cmd.arg("-interaction=nonstopmode")
                .arg("-halt-on-error")
                // Belt to the sandbox's braces: `\write18` is arbitrary command
                // execution, which is strictly worse than arbitrary file reads.
                .arg("-no-shell-escape")
                .arg(format!("-output-directory={}", work_dir.display()))
                .arg("main.tex");
        }
        EngineKind::Tectonic => {
            // `--untrusted` is Tectonic's own hardening switch. Measured, it
            // disables shell-escape but does NOT stop `\openin` from reading
            // arbitrary files — so it is a supplement to the sandbox, never a
            // substitute for it. `--keep-logs` puts main.log where the
            // TeX-family path already expects to find it.
            cmd.arg("--untrusted")
                .arg("--keep-logs")
                .arg("--print")
                .arg("--outdir")
                .arg(work_dir)
                .arg("main.tex");
        }
    }
    cmd.current_dir(work_dir)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    run_bounded(cmd, timeout, Some(policy))
}

/// Which bibliography processor, if any, this document needs.
#[derive(Clone, Copy, PartialEq, Eq)]
enum BibTool {
    Bibtex,
    Biber,
}

impl BibTool {
    fn program(self) -> &'static str {
        match self {
            BibTool::Bibtex => "bibtex",
            BibTool::Biber => "biber",
        }
    }
}

/// Decide what to run between passes, from what the *engine* actually emitted
/// rather than from a guess about the source.
///
/// `main.bcf` means biblatex asked for biber. Otherwise `\bibdata` +
/// `\citation` in the `.aux` is bibtex's own contract, and we additionally
/// require that at least one named `.bib` is resolvable so a document that
/// merely mentions a missing bibliography doesn't get a spurious pass.
fn detect_bib_tool(work_dir: &Path, doc_dir: Option<&Path>) -> Option<BibTool> {
    if work_dir.join("main.bcf").is_file() && resolve_program("biber").is_some() {
        return Some(BibTool::Biber);
    }

    let aux = std::fs::read_to_string(work_dir.join("main.aux")).ok()?;
    if !aux.contains("\\citation{") {
        return None;
    }
    resolve_program("bibtex")?;
    aux_bib_databases(&aux)
        .into_iter()
        .any(|name| bib_exists(&name, work_dir, doc_dir))
        .then_some(BibTool::Bibtex)
}

/// Every database named by a `\bibdata{a,b}` line in an `.aux` file.
fn aux_bib_databases(aux: &str) -> Vec<String> {
    aux.lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("\\bibdata{")?;
            let inner = rest.strip_suffix('}')?;
            Some(inner.split(',').map(|n| n.trim().to_string()))
        })
        .flatten()
        .filter(|name| !name.is_empty())
        .collect()
}

/// True when `name` (with or without a `.bib` suffix) exists in the scratch
/// directory or next to the user's document.
fn bib_exists(name: &str, work_dir: &Path, doc_dir: Option<&Path>) -> bool {
    let with_ext = if name.ends_with(".bib") {
        name.to_string()
    } else {
        format!("{name}.bib")
    };
    [Some(work_dir), doc_dir]
        .into_iter()
        .flatten()
        .any(|dir| dir.join(&with_ext).is_file())
}

/// True when LaTeX itself asked to be run again.
fn needs_rerun(tex_log: &str) -> bool {
    const SIGNALS: [&str; 6] = [
        "Rerun to get",
        "Rerun LaTeX",
        "Please rerun LaTeX",
        "Label(s) may have changed",
        "Citation(s) may have changed",
        "biblatex] Please (re)run",
    ];
    SIGNALS.iter().any(|signal| tex_log.contains(signal))
}

/// The directory a document's relative `\input`, `\includegraphics` and
/// `\bibliography` targets are resolved against.
///
/// This directory is also what the sandbox makes readable, so a document saved
/// directly in `$HOME` gets a compile that can read `$HOME` — the price of
/// supporting multi-file projects at all, and no worse than the directory the
/// user chose to keep the document in.
fn document_directory(doc_path: Option<&str>) -> Option<PathBuf> {
    let raw = doc_path?;
    if raw.is_empty() {
        return None;
    }
    let path = Path::new(raw);
    let parent = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()?.to_path_buf()
    };
    if parent.as_os_str().is_empty() {
        return None;
    }
    // Canonicalise so the sandbox rule and the TEXINPUTS entry name the same
    // directory even when the frontend hands us a path with symlinks or `..`.
    std::fs::canonicalize(&parent)
        .ok()
        .filter(|dir| dir.is_dir())
}

fn compile_failure(log: impl Into<String>) -> CompileResult {
    CompileResult {
        ok: false,
        pdf_bytes: None,
        log: log.into(),
    }
}

fn compile_latex_blocking(
    source: String,
    engine: String,
    doc_path: Option<String>,
) -> CompileResult {
    if !KNOWN_ENGINES.contains(&engine.as_str()) {
        return compile_failure(format!(
            "unsupported engine: `{engine}` (expected one of {})",
            KNOWN_ENGINES.join(", ")
        ));
    }

    // `failed to start \`` is the marker src/lib/tauri.ts matches on to tell
    // "the engine never ran" apart from "the engine ran and rejected the
    // document" — keep the wording.
    let Some(engine_bin) = resolve_program(&engine) else {
        return compile_failure(format!("failed to start `{engine}`: not found on PATH"));
    };

    let dir = match tempfile::Builder::new().prefix("tex-viewer-").tempdir() {
        Ok(d) => d,
        Err(e) => return compile_failure(format!("failed to create a temp directory: {e}")),
    };
    let work_dir = match std::fs::canonicalize(dir.path()) {
        Ok(p) => p,
        Err(e) => return compile_failure(format!("failed to resolve the temp directory: {e}")),
    };

    if let Err(e) = std::fs::write(work_dir.join("main.tex"), source.as_bytes()) {
        return compile_failure(format!("failed to write main.tex: {e}"));
    }

    let kind = EngineKind::of(&engine);
    let doc_dir = document_directory(doc_path.as_deref());
    let env = compile_env(doc_dir.as_deref());
    let mut policy = sandbox::Policy::for_compile(&work_dir, doc_dir.as_deref(), &engine_bin);
    if kind == EngineKind::Tectonic {
        // Tectonic resolves packages from a remote bundle and caches them, so
        // unlike a system TeX it needs its cache tree and a network egress.
        // Granting that is only defensible because the filesystem policy is
        // unchanged: the engine still cannot read anything outside the scratch
        // and document directories, so there is nothing new for it to send.
        // Documented in SECURITY.md.
        policy.allow_network = true;
        policy.read.extend(sandbox::network_resolution_paths());
        policy.read_write.extend(sandbox::tectonic_cache_dirs());
        // The cache tree may not exist yet on a first run, and Landlock drops
        // rules for paths that are absent — which would deny the very
        // directory Tectonic is about to create. Create it up front instead.
        for dir in sandbox::tectonic_cache_dirs() {
            if dir.parent().is_some_and(|p| p.is_dir()) {
                let _ = std::fs::create_dir_all(&dir);
            }
        }
    }

    let budget_deadline = Instant::now() + COMPILE_BUDGET;
    let mut full_log = String::new();
    let mut sandbox_warning: Option<String> = None;
    let mut last_ok = false;
    let mut bib_settled = false;

    for pass in 1..=kind.max_passes() {
        let remaining = budget_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            full_log.push_str(&format!(
                "\n[compile budget of {}s exhausted before pass {pass}]\n",
                COMPILE_BUDGET.as_secs()
            ));
            last_ok = false;
            break;
        }

        let pass_timeout = remaining.min(PASS_TIMEOUT);
        let run = match run_engine_pass(&engine_bin, kind, &work_dir, &env, &policy, pass_timeout) {
            Ok(run) => run,
            Err(e) => {
                full_log.push_str(&format!(
                    "--- pass {pass} ({engine}) ---\nfailed to start `{engine}`: {e}\n"
                ));
                last_ok = false;
                break;
            }
        };

        sandbox_warning = sandbox_warning.or(run.sandbox_warning);
        full_log.push_str(&format!("--- pass {pass} ({engine}) ---\n"));
        full_log.push_str(&run.output);
        if run.timed_out {
            full_log.push_str(&format!(
                "\n[`{engine}` timed out after {}s and was killed]\n",
                pass_timeout.as_secs()
            ));
        }
        full_log.push('\n');

        last_ok = run.success;
        if !last_ok {
            break;
        }

        // The bibliography pass has to happen after the engine has written the
        // .aux/.bcf that names the databases, and before the passes that
        // typeset the resulting .bbl.
        if !bib_settled && !kind.drives_own_bibliography() {
            bib_settled = true;
            if let Some(tool) = detect_bib_tool(&work_dir, doc_dir.as_deref()) {
                let remaining = budget_deadline.saturating_duration_since(Instant::now());
                run_bib_tool(
                    tool,
                    &work_dir,
                    &env,
                    &policy,
                    remaining.min(PASS_TIMEOUT),
                    &mut full_log,
                    &mut sandbox_warning,
                );
                // A .bbl now exists that no pass has read yet.
                continue;
            }
        }

        let tex_log = std::fs::read(work_dir.join("main.log"))
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
        // Two passes minimum, as before, so cross-references and the table of
        // contents resolve even when LaTeX forgets to ask.
        if pass >= 2 && !needs_rerun(&tex_log) {
            break;
        }
    }

    // main.log carries diagnostics even beyond what's echoed to stdout/stderr.
    if let Ok(bytes) = std::fs::read(work_dir.join("main.log")) {
        full_log.push_str("\n--- main.log ---\n");
        full_log.push_str(&String::from_utf8_lossy(&bytes));
    }

    let mut truncated_log = tail(&full_log, LOG_TAIL_CHARS);
    if let Some(warning) = sandbox_warning {
        truncated_log = format!("[warning] {warning}\n\n{truncated_log}");
    }

    if !last_ok {
        return compile_failure(truncated_log);
    }

    match std::fs::read(work_dir.join("main.pdf")) {
        Ok(bytes) => CompileResult {
            ok: true,
            pdf_bytes: Some(bytes),
            log: truncated_log,
        },
        Err(e) => compile_failure(format!("{truncated_log}\nfailed to read main.pdf: {e}")),
    }
}

/// Frame a `CompileResult` for the wire: a little-endian `u32` byte length,
/// a JSON header of exactly that many bytes (`{"ok":…,"log":…}`), then the
/// raw PDF bytes (empty when there are none) to the end of the buffer.
///
/// `tauri::ipc::Response` carries a single opaque byte buffer — it does not
/// let a command hand back "some JSON and also some bytes" as two channels —
/// so the two pieces of `CompileResult` are framed together here and taken
/// apart by `decodeCompileResponse` in `src/lib/tauri.ts`. Keep the two in
/// sync.
fn encode_compile_response(result: CompileResult) -> tauri::ipc::Response {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Header<'a> {
        ok: bool,
        log: &'a str,
    }

    let header_bytes = serde_json::to_vec(&Header {
        ok: result.ok,
        log: &result.log,
    })
    .unwrap_or_default();
    let pdf_bytes = result.pdf_bytes.unwrap_or_default();

    let mut framed = Vec::with_capacity(4 + header_bytes.len() + pdf_bytes.len());
    framed.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    framed.extend_from_slice(&header_bytes);
    framed.extend_from_slice(&pdf_bytes);
    tauri::ipc::Response::new(framed)
}

/// Run bibtex/biber over `main`, appending whatever it said to the log.
///
/// A bibliography tool that fails is not a compile failure: the document still
/// typesets, just with unresolved `\cite`s, and the log explains why.
fn run_bib_tool(
    tool: BibTool,
    work_dir: &Path,
    env: &[(String, String)],
    policy: &sandbox::Policy,
    timeout: Duration,
    log: &mut String,
    sandbox_warning: &mut Option<String>,
) {
    let program = tool.program();
    let Some(binary) = resolve_program(program) else {
        log.push_str(&format!("--- {program} ---\n`{program}` is not on PATH\n\n"));
        return;
    };

    if timeout.is_zero() {
        log.push_str(&format!(
            "--- {program} ---\ncompile budget exhausted; skipped\n\n"
        ));
        return;
    }

    let mut cmd = Command::new(binary);
    cmd.arg("main")
        .current_dir(work_dir)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));

    log.push_str(&format!("--- {program} ---\n"));
    match run_bounded(cmd, timeout, Some(policy)) {
        Ok(run) => {
            *sandbox_warning = sandbox_warning.take().or(run.sandbox_warning);
            log.push_str(&run.output);
            if run.timed_out {
                log.push_str(&format!("\n[`{program}` timed out and was killed]\n"));
            }
        }
        Err(e) => log.push_str(&format!("failed to start `{program}`: {e}\n")),
    }
    log.push('\n');
}

// ---------------------------------------------------------------------------
// Atomic saves
// ---------------------------------------------------------------------------

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write `content` to `target` without ever leaving it half-written.
///
/// `fs::write` truncates first: a crash, a full disk or a killed process between
/// truncate and the last byte leaves the user's document destroyed. Writing a
/// sibling temp file and renaming it over the target makes the replacement
/// atomic — a reader sees either the old file or the new one.
fn write_atomic(target: &Path, content: &[u8]) -> std::io::Result<()> {
    let dir = target.parent().filter(|p| !p.as_os_str().is_empty());
    let dir = match dir {
        Some(d) => d.to_path_buf(),
        None => PathBuf::from("."),
    };
    let stem = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document");

    let temp_path = dir.join(format!(
        ".{stem}.tex-viewer-{}-{}.tmp",
        std::process::id(),
        TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temp_path)?;
        file.write_all(content)?;
        // Get the bytes on disk before the rename, so a crash right after the
        // rename cannot leave an empty file where the document used to be.
        file.sync_all()?;
        drop(file);

        // Keep whatever mode/ACL the existing document had.
        if let Ok(meta) = std::fs::metadata(target) {
            let _ = std::fs::set_permissions(&temp_path, meta.permissions());
        }

        std::fs::rename(&temp_path, target)?;

        #[cfg(unix)]
        if let Ok(handle) = std::fs::File::open(&dir) {
            let _ = handle.sync_all();
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

/// True when `path` names something this editor should be writing.
fn has_savable_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let lowered = ext.to_ascii_lowercase();
            SAVABLE_EXTENSIONS.contains(&lowered.as_str())
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// Every command below is an `async fn` whose real work happens inside
// `spawn_blocking`.
//
// `#[tauri::command(async)]` on a *synchronous* body — what these used to be —
// routes to `async_runtime::spawn`, i.e. a tokio *worker* thread, not a blocking
// one. A body that parks (a modal file dialog, or a poll/sleep loop around a
// 60-second compile) therefore pins one of only `num_cpus` workers for its whole
// duration. On a 2-core machine two such calls consume the pool, and every later
// invoke queues behind them: its JS promise never settles, Save silently does
// nothing, and the compile overlay stays up with nothing to cancel it.
// `spawn_blocking` has a pool sized for exactly this.

#[tauri::command]
async fn compile_latex(
    source: String,
    engine: String,
    doc_path: Option<String>,
) -> tauri::ipc::Response {
    let result =
        tauri::async_runtime::spawn_blocking(move || compile_latex_blocking(source, engine, doc_path))
            .await
            .unwrap_or_else(|e| compile_failure(format!("the compile task failed to run: {e}")));
    encode_compile_response(result)
}

/// Probe one engine with a bounded `--version` call.
fn probe_engine(engine: &str) -> bool {
    let Some(binary) = resolve_program(engine) else {
        return false;
    };
    let mut cmd = Command::new(binary);
    cmd.arg("--version");
    run_bounded(cmd, PROBE_TIMEOUT, None)
        .map(|run| run.success)
        .unwrap_or(false)
}

#[tauri::command]
async fn check_engines() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| {
        // Probed in parallel, each with its own bound, so a single wedged engine
        // costs `PROBE_TIMEOUT` rather than `PROBE_TIMEOUT * KNOWN_ENGINES`.
        let probes: Vec<_> = KNOWN_ENGINES
            .iter()
            .map(|engine| {
                let engine = *engine;
                std::thread::spawn(move || (engine, probe_engine(engine)))
            })
            .collect();

        probes
            .into_iter()
            .filter_map(|handle| handle.join().ok())
            .filter(|(_, present)| *present)
            .map(|(engine, _)| engine.to_string())
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn open_file(app: AppHandle) -> Result<Option<FileContent>, String> {
    // `blocking_pick_file` sends the dialog request to the main thread and then
    // parks on `rx.recv()`; it must not run *on* the main thread (rfd's GTK
    // backend needs the default GMainContext the parked thread would be
    // holding), and it must not run on a tokio worker either, because it holds
    // that worker for as long as the dialog is on screen.
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("LaTeX", &["tex"])
            .blocking_pick_file();

        let Some(picked) = picked else {
            return Ok(None);
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
    })
    .await
    .unwrap_or_else(|e| Err(format!("the open task failed to run: {e}")))
}

#[tauri::command]
async fn save_file(
    app: AppHandle,
    path: Option<String>,
    content: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target_path: PathBuf = match path {
            Some(p) => {
                let candidate = PathBuf::from(p);
                // The caller is the webview, which is rendering an untrusted
                // document; "write these bytes to this path" is not a contract
                // this command should honour unconditionally.
                if !has_savable_extension(&candidate) {
                    return Err(format!(
                        "refusing to save to {}: only {} files can be written",
                        candidate.display(),
                        SAVABLE_EXTENSIONS.join(", ")
                    ));
                }
                candidate
            }
            None => {
                let picked = app
                    .dialog()
                    .file()
                    .add_filter("LaTeX", &["tex"])
                    .blocking_save_file();
                let Some(picked) = picked else {
                    return Ok(None);
                };
                let mut chosen = picked
                    .into_path()
                    .map_err(|e| format!("failed to resolve save path: {e}"))?;
                // The picker's filter is a hint, not a guarantee: a user who
                // types `paper` gets `paper.tex` rather than an extensionless
                // file the next save would then refuse.
                if chosen.extension().is_none() {
                    chosen.set_extension("tex");
                }
                if !has_savable_extension(&chosen) {
                    return Err(format!(
                        "refusing to save to {}: only {} files can be written",
                        chosen.display(),
                        SAVABLE_EXTENSIONS.join(", ")
                    ));
                }
                chosen
            }
        };

        write_atomic(&target_path, content.as_bytes())
            .map_err(|e| format!("failed to write {}: {e}", target_path.display()))?;

        Ok(Some(target_path.display().to_string()))
    })
    .await
    .unwrap_or_else(|e| Err(format!("the save task failed to run: {e}")))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            compile_latex,
            check_engines,
            open_file,
            save_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    // ---- bundled Tectonic engine ------------------------------------------

    #[test]
    fn tectonic_is_offered_but_ranked_below_a_system_tex() {
        assert!(super::KNOWN_ENGINES.contains(&"tectonic"));
        // A system TeX needs no network and carries the user's own packages, so
        // it must win the default selection the frontend makes from this list.
        let tectonic = super::KNOWN_ENGINES.iter().position(|e| *e == "tectonic").unwrap();
        for system in ["pdflatex", "xelatex", "lualatex"] {
            let idx = super::KNOWN_ENGINES.iter().position(|e| *e == system).unwrap();
            assert!(idx < tectonic, "{system} must be offered before tectonic");
        }
    }

    #[test]
    fn engine_kind_separates_tectonic_from_the_tex_family() {
        assert_eq!(super::EngineKind::of("tectonic"), super::EngineKind::Tectonic);
        for system in ["pdflatex", "xelatex", "lualatex"] {
            assert_eq!(super::EngineKind::of(system), super::EngineKind::TexFamily);
        }
    }

    #[test]
    fn tectonic_runs_once_and_resolves_its_own_bibliography() {
        let t = super::EngineKind::Tectonic;
        // Tectonic reruns internally; driving it through our pass loop would
        // typeset the whole document up to MAX_PASSES times over.
        assert_eq!(t.max_passes(), 1);
        assert!(t.drives_own_bibliography());

        let tex = super::EngineKind::TexFamily;
        assert_eq!(tex.max_passes(), super::MAX_PASSES);
        assert!(!tex.drives_own_bibliography());
    }

    #[test]
    fn the_bundled_engine_cannot_collide_with_a_distro_package() {
        // Sidecars are installed into /usr/bin on Linux. A file called plain
        // `tectonic` there would conflict with the distribution's own package,
        // so the shipped name must stay namespaced.
        assert_ne!(super::BUNDLED_ENGINE, "tectonic");
        assert!(super::BUNDLED_ENGINE.starts_with("tex-viewer-"));
    }

    use super::*;
    use tauri::ipc::IpcResponse;

    /// Mirrors `decodeCompileResponse` in `src/lib/tauri.ts` — the tests below
    /// exercise the real wire format `compile_latex` produces.
    fn decode_compile_response(resp: tauri::ipc::Response) -> (bool, String, Option<Vec<u8>>) {
        let framed = match resp.body().expect("response body") {
            tauri::ipc::InvokeResponseBody::Raw(bytes) => bytes,
            tauri::ipc::InvokeResponseBody::Json(_) => panic!("expected a raw byte response"),
        };
        let header_len = u32::from_le_bytes(framed[0..4].try_into().unwrap()) as usize;
        let header: serde_json::Value =
            serde_json::from_slice(&framed[4..4 + header_len]).unwrap();
        let pdf = &framed[4 + header_len..];
        (
            header["ok"].as_bool().unwrap(),
            header["log"].as_str().unwrap().to_string(),
            if pdf.is_empty() { None } else { Some(pdf.to_vec()) },
        )
    }

    #[test]
    fn compile_response_round_trips_success() {
        let result = CompileResult {
            ok: true,
            pdf_bytes: Some(vec![0x25, 0x50, 0x44, 0x46]),
            log: "all good".to_string(),
        };
        let (ok, log, pdf) = decode_compile_response(encode_compile_response(result));
        assert!(ok);
        assert_eq!(log, "all good");
        assert_eq!(pdf, Some(vec![0x25, 0x50, 0x44, 0x46]));
    }

    #[test]
    fn compile_response_round_trips_failure() {
        let (ok, log, pdf) = decode_compile_response(encode_compile_response(compile_failure(
            "boom".to_string(),
        )));
        assert!(!ok);
        assert_eq!(log, "boom");
        assert_eq!(pdf, None);
    }

    #[test]
    fn tail_keeps_the_end() {
        assert_eq!(tail("abcdef", 3), "def");
        assert_eq!(tail("abc", 10), "abc");
        assert_eq!(tail("héllo", 2), "lo");
    }

    #[test]
    fn aux_bib_databases_splits_lists() {
        let aux = "\\citation{a}\n\\bibdata{refs,extra}\n\\bibstyle{plain}\n";
        assert_eq!(aux_bib_databases(aux), vec!["refs", "extra"]);
    }

    #[test]
    fn rerun_signals_are_recognised() {
        assert!(needs_rerun("LaTeX Warning: Label(s) may have changed."));
        assert!(needs_rerun("Rerun to get cross-references right."));
        assert!(!needs_rerun("Output written on main.pdf (1 page)."));
    }

    #[test]
    fn savable_extensions_are_enforced() {
        assert!(has_savable_extension(Path::new("/home/u/paper.tex")));
        assert!(has_savable_extension(Path::new("/home/u/PAPER.TeX")));
        assert!(!has_savable_extension(Path::new("/home/u/.ssh/authorized_keys")));
        assert!(!has_savable_extension(Path::new("/home/u/notes")));
    }

    #[test]
    fn atomic_write_replaces_content() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("doc.tex");
        write_atomic(&target, b"first").unwrap();
        write_atomic(&target, b"second").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "second");
        // No temp files left behind.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    /// Bail out of a test that needs a real TeX installation, saying so on the
    /// way out. A bare `return` would let a machine with no TeX report a green
    /// suite that never checked anything, which is worse than a red one; the
    /// skip is printed (visible under `cargo test -- --nocapture`) so the
    /// difference between "checked" and "not applicable here" is recoverable.
    macro_rules! require_program {
        ($name:literal) => {
            if resolve_program($name).is_none() {
                eprintln!(
                    "SKIPPED: `{}` is not on PATH (this test needs a real TeX installation)",
                    $name
                );
                return;
            }
        };
    }

    /// The finding this guards: a `.tex` is untrusted input, and TeX can read
    /// files. Before the sandbox, this document compiled with exit 0 and put
    /// the first line of /etc/passwd into stdout *and* main.log — both of which
    /// end up in `CompileResult.log`, which the UI renders with a Copy button.
    #[test]
    fn compile_cannot_read_files_outside_the_document_tree() {
        require_program!("pdflatex");
        let source = r"\documentclass{article}
\newread\myfile
\openin\myfile=/etc/passwd
\read\myfile to \myline
\closein\myfile
\typeout{LEAKED>>\myline<<LEAKED}
\begin{document}
hello
\end{document}
";
        let result = compile_latex_blocking(source.to_string(), "pdflatex".to_string(), None);

        // The engine really ran and really reached the `\openin`. Without this
        // the assertions below would also hold for a compile that never
        // started, which is exactly the way this test could rot into a
        // vacuous pass.
        assert!(
            result.log.contains("entering extended mode"),
            "the engine never ran, so nothing was actually exercised:\n{}",
            result.log
        );

        assert!(
            !result.log.contains("root:x:"),
            "/etc/passwd leaked into the compile log:\n{}",
            result.log
        );
        assert!(
            !result.log.contains("/bin/bash") && !result.log.contains("/bin/sh"),
            "a login shell from /etc/passwd leaked into the compile log:\n{}",
            result.log
        );
        assert!(
            !result.log.contains("LEAKED>>root"),
            "the \\typeout echoed file contents into the log:\n{}",
            result.log
        );

        // `compile_latex_blocking` prefixes the log with `[warning] ` when the
        // sandbox could not be installed. When it *was* installed, the read
        // must have been refused by the kernel rather than merely having come
        // back empty — that is the difference between "confined" and "lucky".
        if !result.log.starts_with("[warning]") {
            assert!(
                result.log.contains("/etc/passwd: Permission denied"),
                "the sandbox was enforced but the read was not denied:\n{}",
                result.log
            );
        }
    }

    /// The same read, reached by walking out of the scratch directory instead
    /// of naming an absolute path.
    #[test]
    fn compile_cannot_escape_upwards() {
        require_program!("pdflatex");
        let source = r"\documentclass{article}
\newread\myfile
\openin\myfile=../../../../../../etc/passwd
\read\myfile to \myline
\closein\myfile
\typeout{LEAKED>>\myline<<LEAKED}
\begin{document}
hello
\end{document}
";
        let result = compile_latex_blocking(source.to_string(), "pdflatex".to_string(), None);
        assert!(
            !result.log.contains("root:x:"),
            "/etc/passwd leaked via a relative path:\n{}",
            result.log
        );
    }

    /// Before `doc_path` existed the engine ran in an empty scratch directory,
    /// so no document that splits itself across files could ever compile:
    /// "! LaTeX Error: File `sections/intro.tex' not found. ! Emergency stop."
    #[test]
    fn compile_resolves_inputs_beside_the_document() {
        require_program!("pdflatex");
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(project.path().join("sections")).unwrap();
        std::fs::write(
            project.path().join("sections/intro.tex"),
            "\\section{Intro}\nIncluded from a sibling file.\n",
        )
        .unwrap();
        let main = project.path().join("main.tex");
        let source = "\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n";
        std::fs::write(&main, source).unwrap();

        let result = compile_latex_blocking(
            source.to_string(),
            "pdflatex".to_string(),
            Some(main.to_str().unwrap().to_string()),
        );
        assert!(
            result.ok,
            "multi-file document failed to compile:\n{}",
            result.log
        );
        assert!(result.pdf_bytes.is_some());
    }

    /// End-to-end through the actual IPC command — `doc_path` threading *and*
    /// the `tauri::ipc::Response` framing together, exactly as the real
    /// frontend call goes. Also drops the raw frame in the system temp dir as
    /// `texviewer_compile_frame_test.b64`, so it can be handed to the real,
    /// unmodified `decodeCompileResponse` from `src/lib/tauri.ts` (there is no
    /// JS test runner in this project; this was done ad hoc with `node
    /// --experimental-strip-types` during development) to confirm the two
    /// sides agree on the wire format byte-for-byte, not just against each
    /// side's own idea of it — verified: a real multi-file compile's PDF came
    /// back with `ok: true`, `pdfBytes` starting `%PDF`, and the log showing
    /// `sections/intro` was genuinely read.
    #[test]
    fn compile_latex_command_resolves_multifile_document_end_to_end() {
        require_program!("pdflatex");
        let project = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(project.path().join("sections")).unwrap();
        std::fs::write(
            project.path().join("sections/intro.tex"),
            "\\section{Intro}\nIncluded from a sibling file.\n",
        )
        .unwrap();
        let main = project.path().join("main.tex");
        let source = "\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n";
        std::fs::write(&main, source).unwrap();

        let response = tauri::async_runtime::block_on(compile_latex(
            source.to_string(),
            "pdflatex".to_string(),
            Some(main.to_str().unwrap().to_string()),
        ));
        let framed = match response.body().expect("response body") {
            tauri::ipc::InvokeResponseBody::Raw(bytes) => bytes,
            tauri::ipc::InvokeResponseBody::Json(_) => panic!("expected a raw byte response"),
        };

        std::fs::write(
            std::env::temp_dir().join("texviewer_compile_frame_test.b64"),
            base64_no_dep_encode(&framed),
        )
        .unwrap();

        let (ok, log, pdf) = decode_compile_response(tauri::ipc::Response::new(framed));
        assert!(ok, "multi-file end-to-end compile failed:\n{log}");
        assert!(pdf.is_some_and(|b| !b.is_empty()));
    }

    /// Dependency-free base64 encode, used only to hand the raw frame to the
    /// Node-side cross-check as text — this project dropped its `base64`
    /// dependency along with the base64 IPC encoding it existed for.
    fn base64_no_dep_encode(bytes: &[u8]) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let b0 = chunk[0];
            let b1 = chunk.get(1).copied();
            let b2 = chunk.get(2).copied();
            out.push(ALPHABET[(b0 >> 2) as usize] as char);
            out.push(ALPHABET[(((b0 & 0x03) << 4) | (b1.unwrap_or(0) >> 4)) as usize] as char);
            out.push(if let Some(b1) = b1 {
                ALPHABET[(((b1 & 0x0f) << 2) | (b2.unwrap_or(0) >> 6)) as usize] as char
            } else {
                '='
            });
            out.push(if let Some(b2) = b2 {
                ALPHABET[(b2 & 0x3f) as usize] as char
            } else {
                '='
            });
        }
        out
    }

    /// A document that cites needs bibtex between passes; the fixed `1..=2`
    /// loop meant `\cite` never resolved and the PDF showed [?].
    #[test]
    fn compile_runs_bibtex_and_resolves_citations() {
        require_program!("pdflatex");
        require_program!("bibtex");
        let project = tempfile::tempdir().unwrap();
        std::fs::write(
            project.path().join("refs.bib"),
            "@article{knuth1984,\n author = {Donald E. Knuth},\n title = {Literate Programming},\n journal = {The Computer Journal},\n year = {1984},\n}\n",
        )
        .unwrap();
        let main = project.path().join("main.tex");
        let source = "\\documentclass{article}\n\\begin{document}\nSee \\cite{knuth1984}.\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n";
        std::fs::write(&main, source).unwrap();

        let result = compile_latex_blocking(
            source.to_string(),
            "pdflatex".to_string(),
            Some(main.to_str().unwrap().to_string()),
        );
        assert!(result.ok, "cited document failed to compile:\n{}", result.log);
        assert!(
            result.log.contains("--- bibtex ---"),
            "bibtex never ran:\n{}",
            result.log
        );
        // Pass 1 always reports the citation as undefined — there is no .bbl
        // yet. What matters is the *final* main.log, appended last.
        let (_, final_log) = result.log.split_once("--- main.log ---").unwrap();
        assert!(
            !final_log.contains("Citation `knuth1984' undefined"),
            "the citation never resolved:\n{final_log}"
        );
        assert!(
            !final_log.contains("There were undefined references"),
            "references were still undefined on the last pass:\n{final_log}"
        );
    }

    /// A plain document with no `doc_path` must still compile: the sandbox
    /// allowlist has to cover the whole TeX installation.
    #[test]
    fn compile_still_works_for_a_self_contained_document() {
        require_program!("pdflatex");
        let source = "\\documentclass{article}\n\\begin{document}\n\\section{Hi}\nBody text.\n\\tableofcontents\n\\end{document}\n";
        let result =
            compile_latex_blocking(source.to_string(), "pdflatex".to_string(), None);
        assert!(result.ok, "plain document failed to compile:\n{}", result.log);
    }

    /// The old timeout was not one: `kill()` was followed by an unbounded
    /// `wait()`, so a process that did not die on cue held the caller forever.
    #[test]
    fn run_bounded_is_actually_bounded() {
        let Some(sleep) = resolve_program("sleep") else {
            return;
        };
        let mut cmd = Command::new(sleep);
        cmd.arg("30");
        let start = Instant::now();
        let run = run_bounded(cmd, Duration::from_millis(300), None).unwrap();
        assert!(run.timed_out, "the overrunning process was not timed out");
        assert!(!run.success);
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "run_bounded waited {:?} for a process it had killed",
            start.elapsed()
        );
    }

    /// A grandchild inheriting stdout keeps the pipe open after the child
    /// exits. Reading it with a plain `join()` would never return, so the
    /// readers are abandonable.
    #[test]
    fn run_bounded_does_not_wait_forever_on_an_inherited_pipe() {
        let Some(sh) = resolve_program("sh") else {
            return;
        };
        let mut cmd = Command::new(sh);
        cmd.arg("-c").arg("sleep 60 & echo started");
        let start = Instant::now();
        let run = run_bounded(cmd, Duration::from_secs(20), None).unwrap();
        assert!(run.success, "the shell itself should have exited cleanly");
        assert!(run.output.contains("started"));
        assert!(
            start.elapsed() < PIPE_DRAIN_GRACE + Duration::from_secs(5),
            "waited {:?} on a pipe a grandchild was still holding",
            start.elapsed()
        );
    }

    /// Exercises the async command wrappers (and their `spawn_blocking`
    /// plumbing) with several compiles genuinely in flight at once.
    #[test]
    fn concurrent_compiles_all_settle() {
        require_program!("pdflatex");
        let source = "\\documentclass{article}\n\\begin{document}Concurrent.\\end{document}\n";
        let results = tauri::async_runtime::block_on(async {
            let handles: Vec<_> = (0..6)
                .map(|_| {
                    tauri::async_runtime::spawn(compile_latex(
                        source.to_string(),
                        "pdflatex".to_string(),
                        None,
                    ))
                })
                .collect();
            let mut settled = Vec::new();
            for handle in handles {
                settled.push(handle.await.expect("a compile task never settled"));
            }
            settled
        });
        assert_eq!(results.len(), 6);
        for result in results {
            let (ok, log, _pdf) = decode_compile_response(result);
            assert!(ok, "concurrent compile failed:\n{log}");
        }
    }

    #[test]
    fn document_directory_resolves_the_parent() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("main.tex");
        std::fs::write(&file, "x").unwrap();
        let resolved = document_directory(Some(file.to_str().unwrap())).unwrap();
        assert_eq!(resolved, std::fs::canonicalize(dir.path()).unwrap());
        assert!(document_directory(None).is_none());
        assert!(document_directory(Some("")).is_none());
    }

    // -----------------------------------------------------------------------
    // Pure unit tests - no TeX installation required
    // -----------------------------------------------------------------------

    /// `engine` arrives from the webview. It is used to build a `Command`, so
    /// "whatever string you send" would be arbitrary process execution; only
    /// the three engines we know how to drive are accepted, and the check has
    /// to happen before anything is spawned.
    #[test]
    fn an_unknown_engine_is_refused_before_anything_is_spawned() {
        for hostile in ["sh", "rm", "../../bin/sh", "pdflatex; rm -rf /", ""] {
            let result = compile_latex_blocking(
                "\\documentclass{article}\\begin{document}x\\end{document}".to_string(),
                hostile.to_string(),
                None,
            );
            assert!(!result.ok, "`{hostile}` was accepted as an engine");
            assert!(
                result.log.starts_with("unsupported engine:"),
                "`{hostile}` got past the allowlist: {}",
                result.log
            );
        }
        for known in KNOWN_ENGINES {
            assert!(!compile_failure(format!("unsupported engine: `{known}`"))
                .log
                .is_empty());
        }
    }

    /// The historical kpathsea controls are a no-op on TeX Live 2026 and later,
    /// but they are still a real control on every earlier distribution, so they
    /// must keep being set - and `\write18` must stay off in the environment as
    /// well as on the command line.
    #[test]
    fn compile_env_sets_the_kpathsea_controls() {
        let env = compile_env(None);
        let get = |key: &str| {
            env.iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(get("openin_any").as_deref(), Some("p"));
        assert_eq!(get("openout_any").as_deref(), Some("p"));
        assert_eq!(get("shell_escape").as_deref(), Some("f"));
        // With no document directory there is nothing to add to the search path.
        assert!(get("TEXINPUTS").is_none());
    }

    /// A multi-file document resolves its `\input`s against the directory the
    /// document lives in; the scratch directory has to stay first, because that
    /// is where main.tex and the generated .aux/.bbl are.
    #[test]
    fn compile_env_puts_the_document_directory_on_the_search_path() {
        let dir = tempfile::tempdir().unwrap();
        let env = compile_env(Some(dir.path()));
        for var in ["TEXINPUTS", "BIBINPUTS", "BSTINPUTS"] {
            let value = env
                .iter()
                .find(|(k, _)| k == var)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| panic!("{var} was not set"));
            assert!(value.starts_with('.'), "{var} does not start with `.`: {value}");
            assert!(value.contains(&dir.path().display().to_string()));
            assert!(value.ends_with(KPSE_SEP), "{var} must keep kpathsea's defaults");
        }
    }

    #[test]
    fn tectonic_is_offered_and_driven_differently_from_the_tex_family() {
        // It is in the picker: the bundled engine is the reason a fresh
        // install can compile at all.
        assert!(KNOWN_ENGINES.contains(&"tectonic"));
        // ...and last, so a system TeX — which needs no network and carries the
        // user's own packages — wins when one is installed.
        assert_eq!(*KNOWN_ENGINES.last().unwrap(), "tectonic");

        assert_eq!(EngineKind::of("tectonic"), EngineKind::Tectonic);
        for tex in ["pdflatex", "xelatex", "lualatex"] {
            assert_eq!(EngineKind::of(tex), EngineKind::TexFamily, "{tex}");
        }

        // Tectonic reruns internally and resolves its own bibliography.
        // Driving it through our loop would typeset the document five times
        // over and run bibtex against files it already consumed.
        assert_eq!(EngineKind::Tectonic.max_passes(), 1);
        assert!(EngineKind::Tectonic.drives_own_bibliography());
        assert_eq!(EngineKind::TexFamily.max_passes(), MAX_PASSES);
        assert!(!EngineKind::TexFamily.drives_own_bibliography());
    }

    #[test]
    fn the_bundled_engine_name_cannot_collide_with_a_system_package() {
        // Sidecars are installed into /usr/bin on Linux. Shipping one called
        // plain `tectonic` would fight the distribution's own package for the
        // same path.
        assert_ne!(BUNDLED_ENGINE, "tectonic");
        assert!(BUNDLED_ENGINE.starts_with("tex-viewer-"));
    }

    #[test]
    fn resolve_program_rejects_a_path_that_is_not_an_executable_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_program(dir.path().to_str().unwrap()).is_none());
        assert!(resolve_program(dir.path().join("nope").to_str().unwrap()).is_none());
        assert!(resolve_program("this-program-does-not-exist-anywhere").is_none());
    }

    #[test]
    fn bib_exists_looks_beside_the_document_as_well_as_in_the_scratch_dir() {
        let work = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("refs.bib"), "").unwrap();

        assert!(bib_exists("refs", work.path(), Some(project.path())));
        assert!(bib_exists("refs.bib", work.path(), Some(project.path())));
        assert!(!bib_exists("refs", work.path(), None));
        assert!(!bib_exists("missing", work.path(), Some(project.path())));
    }

    /// A document that merely *mentions* a bibliography it does not have must
    /// not buy itself a bibtex pass out of the compile budget.
    #[test]
    fn detect_bib_tool_ignores_a_citation_with_no_resolvable_database() {
        let work = tempfile::tempdir().unwrap();
        std::fs::write(
            work.path().join("main.aux"),
            "\\citation{a}\n\\bibdata{nowhere}\n",
        )
        .unwrap();
        assert!(detect_bib_tool(work.path(), None).is_none());

        // No `\citation` at all: nothing to resolve either.
        std::fs::write(work.path().join("main.aux"), "\\bibdata{refs}\n").unwrap();
        std::fs::write(work.path().join("refs.bib"), "").unwrap();
        assert!(detect_bib_tool(work.path(), None).is_none());
    }

    #[test]
    fn aux_bib_databases_ignores_malformed_lines() {
        assert!(aux_bib_databases("\\bibdata{}\n").is_empty());
        assert!(aux_bib_databases("\\bibdata{unterminated\n").is_empty());
        assert!(aux_bib_databases("nothing here\n").is_empty());
        assert_eq!(aux_bib_databases("\\bibdata{ a , b }\n"), vec!["a", "b"]);
    }

    #[test]
    fn document_directory_rejects_paths_that_do_not_exist() {
        assert!(document_directory(Some("/definitely/not/a/real/path/main.tex")).is_none());
        assert!(document_directory(Some("main.tex")).is_none());
    }

    /// `save_file` is reachable from the webview, so the extension allowlist is
    /// load-bearing: it is what stops a compromised frontend truncating a file
    /// a LaTeX editor has no business writing.
    #[test]
    fn savable_extensions_reject_everything_outside_the_allowlist() {
        for bad in [
            "/home/u/.bashrc",
            "/home/u/.ssh/config",
            "/home/u/run.sh",
            "/home/u/lib.so",
            "/home/u/archive.tar.gz",
            "/home/u/main.tex.exe",
        ] {
            assert!(
                !has_savable_extension(Path::new(bad)),
                "{bad} should not be savable"
            );
        }
        for good in ["/home/u/main.tex", "/home/u/refs.bib", "/home/u/notes.md"] {
            assert!(has_savable_extension(Path::new(good)), "{good} should be savable");
        }
    }

}

