//! Filesystem/network confinement for the child processes we hand an untrusted
//! `.tex` document to. OWNER: rust agent.
//!
//! # Why this exists
//!
//! A `.tex` file is untrusted input (an arXiv bundle, a collaborator's draft),
//! and TeX is a programming language with file I/O. A three-line preamble is
//! enough to slurp any file the user can read into the compile log:
//!
//! ```tex
//! \newread\f \openin\f=/etc/passwd \read\f to \l \typeout{\l}
//! ```
//!
//! which lands in stdout *and* `main.log`, both of which the UI displays.
//!
//! The classic mitigation was kpathsea's `openin_any=p`. That is no longer a
//! mitigation: TeX Live 2026 turned it into a documented no-op ("the underlying
//! `kpse_in_name_ok` and related functions always return true [...] there were
//! obscure ways to inject arbitrary input from the supposedly-forbidden areas,
//! so it gave a false sense of security" — `texmf.cnf`). We still set it,
//! because it is a real control on every TeX distribution older than that, but
//! it cannot be the only one.
//!
//! So the restriction is applied from the outside, by the kernel, via Landlock:
//! the engine gets read access to the TeX installation and to the directory the
//! document actually lives in, read/write access to the scratch directory, and
//! nothing else. `$HOME`, `/etc/passwd`, `~/.ssh`, other users' files and the
//! network are simply not reachable, and a denial surfaces to TeX as an
//! ordinary "file not found".
//!
//! Landlock is per-*thread* and inherited across `fork`/`exec`, so callers
//! confine a short-lived dedicated thread and spawn the child from it (see
//! `spawn_confined` in `lib.rs`). Nothing is applied in a post-`fork` hook, and
//! the calling worker thread keeps its normal ambient rights.

use std::path::{Path, PathBuf};

/// System locations a TeX engine legitimately reads from.
///
/// Deliberately *not* all of `/etc`: the whole point is that `/etc/passwd`,
/// `/etc/shadow` and friends stay unreachable.
const SYSTEM_READ_DIRS: &[&str] = &[
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/opt",
    "/etc/texmf",
    "/etc/texlive",
    "/etc/fonts",
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
    "/etc/localtime",
    "/etc/alternatives",
    // libpaper: the paper *name* and the spec database it is looked up in.
    // Without the latter, xdvipdfmx aborts with "Unrecognized paper format".
    "/etc/papersize",
    "/etc/paperspecs",
    "/etc/locale.conf",
    "/etc/xdg",
    "/etc/timezone",
    "/var/lib/texmf",
    "/var/cache/fontconfig",
    // Only stable, process-independent /proc entries: a `/proc/self` rule would
    // pin *our* pid's directory, which is not the child's, and granting `/proc`
    // wholesale would expose other same-uid processes' environ and cmdline.
    "/proc/cpuinfo",
    "/proc/meminfo",
    "/sys/devices/system/cpu",
];

/// Character devices the C runtime and TeX expect to be able to open r/w.
const SYSTEM_RW_DEVICES: &[&str] = &[
    "/dev/null",
    "/dev/zero",
    "/dev/full",
    "/dev/random",
    "/dev/urandom",
    "/dev/tty",
    "/dev/shm",
];

/// What a confined child may touch. Paths that do not exist are dropped when
/// the ruleset is built, so every list can be a superset of reality.
#[derive(Debug, Default, Clone)]
pub struct Policy {
    /// Readable and executable.
    pub read: Vec<PathBuf>,
    /// Readable and writable (scratch space, caches).
    pub read_write: Vec<PathBuf>,
    /// Writable but not readable — somewhere to drop temp files without being
    /// able to read what other programs left behind.
    ///
    /// Only the Landlock backend reads this, so off Linux it is dead in the
    /// library and `-D warnings` fails the build (it did, on both macOS
    /// runners). `allow` rather than `expect`: the unit tests *do* read it on
    /// every platform, so under `--all-targets` an expectation is fulfilled in
    /// the lib target and unfulfilled in the test target, which is itself an
    /// error.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub write_only: Vec<PathBuf>,
    /// Whether the child may open TCP sockets.
    ///
    /// Off for a system TeX, which has every package it needs on disk, so the
    /// obvious way to ship a file off the machine is closed. On only for
    /// Tectonic, which fetches its packages from a remote bundle and cannot
    /// work without egress. That is a narrower concession than it looks: the
    /// filesystem rules are identical either way, so a document that gains
    /// network still cannot read anything outside its own directory tree.
    pub allow_network: bool,
}

impl Policy {
    /// The policy for one compile: system TeX trees + the engine binary's own
    /// directory are readable, `work_dir` is read/write, and `doc_dir` — the
    /// directory the user's document lives in, which is where `\input`,
    /// `\includegraphics` and `\bibliography` targets are — is readable.
    pub fn for_compile(work_dir: &Path, doc_dir: Option<&Path>, engine_bin: &Path) -> Self {
        let mut read: Vec<PathBuf> = SYSTEM_READ_DIRS.iter().map(PathBuf::from).collect();
        let mut read_write: Vec<PathBuf> = SYSTEM_RW_DEVICES.iter().map(PathBuf::from).collect();

        if let Some(bin_dir) = engine_bin.parent() {
            read.push(bin_dir.to_path_buf());
        }

        let texmf = texmf_trees();
        read.extend(texmf.read.iter().cloned());
        read_write.extend(texmf.write.iter().cloned());

        if let Some(cache) = user_cache_dir() {
            read_write.push(cache.join("fontconfig"));
        }

        if let Some(dir) = doc_dir {
            read.push(dir.to_path_buf());
        }

        read_write.push(work_dir.to_path_buf());

        Policy {
            read,
            read_write,
            // The engine's scratch directory is `work_dir`; anything that
            // insists on the system temp dir (mktex* helpers) may create files
            // there but must not be able to read other processes' leftovers.
            write_only: vec![std::env::temp_dir()],
            allow_network: false,
        }
    }
}

/// Result of installing a [`Policy`] on the calling thread.
pub enum Status {
    /// The kernel is enforcing the policy.
    ///
    /// Constructed only by the Landlock backend; see the note on
    /// `Policy::write_only` for why this is `allow` and not `expect`.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Enforced,
    /// The policy is not (or only partly) in force; the reason is meant to be
    /// surfaced to the user, since it means the compile is running unconfined.
    NotEnforced(String),
}

impl Status {
    /// The note to append to the compile log, if any.
    pub fn warning(&self) -> Option<&str> {
        match self {
            Status::Enforced => None,
            Status::NotEnforced(msg) => Some(msg.as_str()),
        }
    }
}

/// Apply `policy` to the calling thread. Every process this thread goes on to
/// spawn inherits it.
#[cfg(target_os = "linux")]
pub fn confine_current_thread(policy: &Policy) -> Status {
    use landlock::{
        Access, AccessFs, AccessNet, CompatLevel, Compatible, RulesetAttr, RulesetCreatedAttr,
        RulesetStatus, ABI,
    };

    // V6 is the newest ABI this crate models; `BestEffort` silently drops the
    // access rights an older kernel does not implement rather than failing.
    let abi = ABI::V6;

    let build = || -> Result<landlock::RestrictionStatus, landlock::RulesetError> {
        let mut attr = landlock::Ruleset::default()
            .set_compatibility(CompatLevel::BestEffort)
            .handle_access(AccessFs::from_all(abi))?;
        if !policy.allow_network {
            // With no matching allow-rule added below, handling the access at
            // all is what denies it outright.
            attr = attr.handle_access(AccessNet::BindTcp | AccessNet::ConnectTcp)?;
        }
        attr.create()?
            .add_rules(landlock::path_beneath_rules(
                &policy.read,
                AccessFs::from_read(abi),
            ))?
            .add_rules(landlock::path_beneath_rules(
                &policy.read_write,
                AccessFs::from_all(abi),
            ))?
            .add_rules(landlock::path_beneath_rules(
                &policy.write_only,
                AccessFs::from_write(abi),
            ))?
            .restrict_self()
    };

    match build() {
        Ok(status) => match status.ruleset {
            RulesetStatus::FullyEnforced => Status::Enforced,
            RulesetStatus::PartiallyEnforced => Status::NotEnforced(
                "this kernel supports only part of the Landlock policy; the LaTeX engine is \
                 partially confined"
                    .to_string(),
            ),
            RulesetStatus::NotEnforced => Status::NotEnforced(
                "Landlock is unavailable on this kernel; the LaTeX engine is running \
                 unconfined and a malicious .tex can read any file you can read"
                    .to_string(),
            ),
        },
        Err(e) => Status::NotEnforced(format!(
            "could not confine the LaTeX engine ({e}); it is running unconfined and a \
             malicious .tex can read any file you can read"
        )),
    }
}

/// No sandbox implementation on this platform yet.
#[cfg(not(target_os = "linux"))]
pub fn confine_current_thread(_policy: &Policy) -> Status {
    Status::NotEnforced(
        "the LaTeX engine sandbox is implemented with Landlock and is therefore Linux-only; \
         on this platform the engine runs unconfined and a malicious .tex can read any file \
         you can read"
            .to_string(),
    )
}

/// The TeX installation's own directory trees, split by whether TeX needs to
/// write to them (font/format caches) or only read them.
#[derive(Debug, Default)]
pub struct TexmfTrees {
    pub read: Vec<PathBuf>,
    pub write: Vec<PathBuf>,
}

/// Ask kpathsea where this TeX installation keeps its trees, once per process.
///
/// Hardcoding `/usr/share/texmf-dist` would break every TeX Live installed
/// under `$HOME`, so the layout is discovered rather than assumed.
pub fn texmf_trees() -> &'static TexmfTrees {
    static TREES: std::sync::OnceLock<TexmfTrees> = std::sync::OnceLock::new();
    TREES.get_or_init(discover_texmf_trees)
}

/// Variables whose trees TeX may need to *write* (format dumps, luaotfload's
/// font cache). Order matters only for readability.
const TEXMF_WRITE_VARS: [&str; 3] = ["TEXMFVAR", "TEXMFCONFIG", "TEXMFCACHE"];
/// Variables whose trees TeX only reads.
const TEXMF_READ_VARS: [&str; 5] = [
    "TEXMFHOME",
    "TEXMFLOCAL",
    "TEXMFDIST",
    "TEXMFMAIN",
    "TEXMFSYSCONFIG",
];

fn discover_texmf_trees() -> TexmfTrees {
    let mut spec = String::new();
    for var in TEXMF_WRITE_VARS.iter().chain(TEXMF_READ_VARS.iter()) {
        if !spec.is_empty() {
            spec.push('|');
        }
        spec.push('$');
        spec.push_str(var);
    }

    // `kpsewhich --expand-var` answers for all of them in one spawn; each field
    // may itself be a `:`-separated list (TEXMFLOCAL commonly is).
    let expanded = match crate::run_capture(
        "kpsewhich",
        &[format!("--expand-var={spec}")],
        std::time::Duration::from_secs(10),
    ) {
        Some(out) => out,
        None => return TexmfTrees::default(),
    };

    let fields: Vec<&str> = expanded.trim().split('|').collect();
    let write_count = TEXMF_WRITE_VARS.len();

    let mut trees = TexmfTrees::default();
    for (index, field) in fields.iter().enumerate() {
        let target = if index < write_count {
            &mut trees.write
        } else {
            &mut trees.read
        };
        for raw in field.split([':', ';']) {
            // kpathsea marks "only look at the ls-R database" trees with `!!`.
            let cleaned = raw.trim().trim_start_matches('!');
            if cleaned.is_empty() || cleaned.contains(['{', '}', '$']) {
                continue;
            }
            let path = PathBuf::from(cleaned);
            if path.is_absolute() && !target.contains(&path) {
                target.push(path);
            }
        }
    }

    // A first-ever run has no cache directory yet, and the sandbox cannot grant
    // access to a path that does not exist — so create the ones TeX would have
    // created itself.
    for dir in &trees.write {
        let _ = std::fs::create_dir_all(dir);
    }

    trees
}

/// `$XDG_CACHE_HOME`, or `$HOME/.cache`.
/// The files a networked child needs in order to resolve a hostname and verify
/// a TLS certificate. Granted only alongside [`Policy::allow_network`], so the
/// system-TeX policy — which needs no network — never widens to include them.
///
/// Without these Tectonic does not fail gracefully: it panics inside its C
/// bridge (`ttbc_input_open` -> `panic_cannot_unwind`) rather than reporting
/// that it could not reach the bundle server.
pub fn network_resolution_paths() -> Vec<PathBuf> {
    [
        "/etc/ssl",
        "/etc/pki",
        "/etc/ca-certificates",
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/resolv.conf",
        "/etc/hosts",
        "/etc/nsswitch.conf",
        "/etc/gai.conf",
        "/etc/services",
    ]
    .iter()
    .map(PathBuf::from)
    .collect()
}

/// Where Tectonic keeps its downloaded resource bundle. It must be read/write
/// or every compile re-downloads, and the first compile cannot work at all.
pub fn tectonic_cache_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(cache) = user_cache_dir() {
        // Lowercase on Linux (XDG), capitalised on macOS.
        dirs.push(cache.join("tectonic"));
        dirs.push(cache.join("Tectonic"));
    }
    if let Some(data) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(data).join("TectonicProject").join("Tectonic"));
    }
    dirs
}

fn user_cache_dir() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CACHE_HOME") {
        let path = PathBuf::from(xdg);
        if path.is_absolute() {
            return Some(path);
        }
    }
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_compile_policy_has_no_network_by_default() {
        let work = scratch();
        let policy = Policy::for_compile(work.path(), None, std::path::Path::new("/usr/bin/pdflatex"));
        // A system TeX has every package it needs on disk. Denying egress
        // closes the obvious way to ship a file off the machine.
        assert!(!policy.allow_network);
    }

    #[test]
    fn the_networked_engine_gets_resolution_files_a_system_tex_never_does() {
        let work = scratch();
        let offline = Policy::for_compile(work.path(), None, std::path::Path::new("/usr/bin/pdflatex"));
        let resolution = network_resolution_paths();
        assert!(!resolution.is_empty());

        // Without these Tectonic panics inside its C bridge rather than
        // reporting that it could not reach the bundle server - but they must
        // not be handed to an engine that has no business talking to the
        // network.
        for path in &resolution {
            assert!(
                !offline.read.contains(path),
                "{} must not be readable by a non-networked compile",
                path.display()
            );
        }
    }

    #[test]
    fn the_resolution_set_never_includes_the_secrets_the_policy_exists_to_hide() {
        for path in network_resolution_paths() {
            let s = path.to_string_lossy().to_string();
            for secret in ["/etc/passwd", "/etc/shadow", "/etc/sudoers", "/root", "/home"] {
                assert_ne!(s, secret);
                assert!(!s.starts_with(&format!("{secret}/")), "{s} reaches {secret}");
            }
            // Granting /etc wholesale would defeat the point of listing files.
            assert_ne!(s, "/etc");
        }
    }

    use super::*;

    /// True when `target` sits under one of the granted trees. Landlock rules
    /// are `path_beneath`, so a rule grants its whole subtree — which is
    /// exactly what has to be checked against, not string equality.
    fn covered(rules: &[PathBuf], target: &Path) -> bool {
        rules.iter().any(|rule| target.starts_with(rule))
    }

    fn scratch() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    #[test]
    fn compile_policy_grants_the_scratch_and_document_trees() {
        let work = scratch();
        let doc = scratch();
        let engine = PathBuf::from("/usr/bin/pdflatex");
        let policy = Policy::for_compile(work.path(), Some(doc.path()), &engine);

        assert!(
            covered(&policy.read_write, work.path()),
            "the engine cannot write its own scratch directory"
        );
        assert!(
            covered(&policy.read, doc.path()),
            "the engine cannot read the directory the document lives in"
        );
        // The engine's own directory has to be readable/executable, or nothing
        // runs at all on a TeX Live installed outside /usr.
        assert!(covered(&policy.read, Path::new("/usr/bin/pdflatex")));
    }

    /// The finding this guards: a `.tex` is untrusted input and TeX has file
    /// I/O, so the policy is what stands between `\openin=/etc/passwd` and the
    /// compile log. No rule may grant a tree that contains it.
    #[test]
    fn compile_policy_never_reaches_the_secrets_a_tex_file_would_go_after() {
        let work = scratch();
        let doc = scratch();
        let policy = Policy::for_compile(work.path(), Some(doc.path()), Path::new("/usr/bin/pdflatex"));

        let all: Vec<PathBuf> = policy
            .read
            .iter()
            .chain(policy.read_write.iter())
            .cloned()
            .collect();

        for secret in [
            "/etc/passwd",
            "/etc/shadow",
            "/etc/sudoers",
            "/etc/ssh/ssh_host_rsa_key",
            "/root/.ssh/id_ed25519",
            "/var/log/auth.log",
        ] {
            assert!(
                !covered(&all, Path::new(secret)),
                "the compile policy grants read access to {secret}"
            );
        }

        // `/etc` is granted only as named subdirectories, never wholesale.
        assert!(!all.iter().any(|p| p == Path::new("/etc")));
        assert!(!all.iter().any(|p| p == Path::new("/")));
        assert!(!all.iter().any(|p| p == Path::new("/home")));

        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            // A TeX tree or font cache under $HOME is legitimate; $HOME itself
            // (and therefore ~/.ssh) is not.
            assert!(!all.contains(&home), "$HOME is granted wholesale");
            assert!(
                !covered(&all, &home.join(".ssh").join("id_ed25519")),
                "~/.ssh is reachable from the compile policy"
            );
            assert!(
                !covered(&all, &home.join(".aws").join("credentials")),
                "~/.aws is reachable from the compile policy"
            );
        }
    }

    /// The system temp directory is write-only: somewhere the mktex* helpers
    /// can drop files without being able to read what other processes left
    /// behind there.
    #[test]
    fn compile_policy_keeps_the_system_temp_dir_write_only() {
        let work = scratch();
        let policy = Policy::for_compile(work.path(), None, Path::new("/usr/bin/pdflatex"));
        assert!(covered(&policy.write_only, &std::env::temp_dir()));
        assert!(!covered(&policy.read, &std::env::temp_dir()));
    }

    /// With no document open there is no document directory to grant, and the
    /// policy must not quietly widen to compensate.
    #[test]
    fn compile_policy_grants_nothing_extra_without_a_document_directory() {
        let work = scratch();
        let with = Policy::for_compile(work.path(), Some(work.path()), Path::new("/usr/bin/pdflatex"));
        let without = Policy::for_compile(work.path(), None, Path::new("/usr/bin/pdflatex"));
        assert_eq!(without.read.len() + 1, with.read.len());
    }

    /// The whole of the above is a statement about a data structure. This is
    /// the statement about the kernel: install a policy that grants exactly one
    /// scratch directory, then confirm from inside the confined thread that the
    /// scratch file is readable and `/etc/passwd` is not.
    ///
    /// Landlock is irreversible and per-thread, so the restriction is installed
    /// on a thread spawned for the purpose - the same shape `spawn_confined`
    /// uses in `lib.rs`.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_compile_policy_denies_the_network_by_default() {
        let work = scratch();
        let policy = Policy::for_compile(work.path(), None, Path::new("/usr/bin/pdflatex"));
        // A system TeX has every package it needs on disk, so egress stays shut
        // and the obvious way to ship a file off the machine is closed.
        assert!(!policy.allow_network);
    }

    #[test]
    fn resolver_and_tls_paths_are_not_granted_to_an_offline_compile() {
        let work = scratch();
        let policy = Policy::for_compile(work.path(), None, Path::new("/usr/bin/pdflatex"));
        // These are only defensible for the one engine that must reach the
        // network; the offline path must not quietly widen to include them.
        for p in ["/etc/resolv.conf", "/etc/hosts", "/etc/ssl"] {
            assert!(
                !policy.read.iter().any(|granted| granted == Path::new(p)),
                "offline compile should not be granted {p}"
            );
        }
        // And they are exactly what the networked engine does get.
        let networked = network_resolution_paths();
        for p in ["/etc/resolv.conf", "/etc/hosts", "/etc/ssl"] {
            assert!(networked.iter().any(|granted| granted == Path::new(p)), "{p}");
        }
    }

    #[test]
    fn the_tectonic_cache_is_never_a_place_secrets_live() {
        for dir in tectonic_cache_dirs() {
            let s = dir.to_string_lossy().to_lowercase();
            assert!(s.contains("tectonic"), "unexpectedly broad cache grant: {dir:?}");
        }
    }

    #[test]
    fn landlock_blocks_the_reads_the_policy_does_not_grant() {
        let work = scratch();
        let allowed = work.path().join("allowed.txt");
        std::fs::write(&allowed, "scratch contents").unwrap();

        let policy = Policy {
            read: Vec::new(),
            read_write: vec![work.path().to_path_buf()],
            write_only: Vec::new(),
            allow_network: false,
        };

        let outcome = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let status = confine_current_thread(&policy);
                    if let Some(reason) = status.warning() {
                        return Err(reason.to_string());
                    }
                    Ok((
                        std::fs::read_to_string(&allowed),
                        std::fs::read_to_string("/etc/passwd"),
                    ))
                })
                .join()
                .expect("the confined thread panicked")
        });

        let (granted, denied) = match outcome {
            Ok(pair) => pair,
            Err(reason) => {
                eprintln!("SKIPPED landlock enforcement test: {reason}");
                return;
            }
        };

        assert_eq!(
            granted.expect("the granted scratch directory was not readable"),
            "scratch contents"
        );
        let err = denied.expect_err("/etc/passwd was readable from inside the sandbox");
        assert_eq!(
            err.kind(),
            std::io::ErrorKind::PermissionDenied,
            "reading /etc/passwd failed, but not because the kernel refused it: {err}"
        );
    }

    /// The control for the test above: without confinement the very same read
    /// succeeds, so a green result there is the sandbox and not the
    /// environment.
    #[test]
    fn the_denied_read_succeeds_without_the_sandbox() {
        if !Path::new("/etc/passwd").exists() {
            eprintln!("SKIPPED: this system has no /etc/passwd to use as a control");
            return;
        }
        assert!(std::fs::read_to_string("/etc/passwd").is_ok());
    }

    #[test]
    fn system_read_dirs_name_no_secret_bearing_tree() {
        for dir in SYSTEM_READ_DIRS {
            let path = Path::new(dir);
            assert!(path.is_absolute(), "{dir} is not an absolute path");
            for secret in ["/etc/passwd", "/etc/shadow", "/root/.ssh/id_rsa"] {
                assert!(
                    !Path::new(secret).starts_with(path),
                    "{dir} would expose {secret}"
                );
            }
        }
    }

    /// kpathsea is asked where this installation keeps its trees rather than
    /// `/usr/share/texmf-dist` being assumed, so a TeX Live under $HOME works.
    #[test]
    fn texmf_trees_are_discovered_not_assumed() {
        if crate::resolve_program("kpsewhich").is_none() {
            eprintln!("SKIPPED: `kpsewhich` is not on PATH (this test needs a real TeX installation)");
            return;
        }
        let trees = texmf_trees();
        assert!(
            !trees.read.is_empty() || !trees.write.is_empty(),
            "kpsewhich is installed but no texmf tree was discovered"
        );
        for path in trees.read.iter().chain(trees.write.iter()) {
            assert!(path.is_absolute(), "{} is not absolute", path.display());
            let text = path.to_string_lossy();
            // Unexpanded kpathsea syntax must never become a Landlock rule.
            assert!(!text.contains('$') && !text.contains('{') && !text.contains('!'));
        }
        // The trees TeX writes to are created if they do not exist yet, because
        // a rule cannot be added for a path that is not there.
        for path in &trees.write {
            assert!(path.is_dir(), "{} was not created", path.display());
        }
    }
}
