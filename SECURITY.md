# Security

## The threat model

A `.tex` file is untrusted input. People routinely compile documents they did
not write — an arXiv source bundle, a co-author's draft, a template off the
internet — and TeX is a full programming language with file and process access.
The renderer treats document text as hostile and escapes it; this file is about
the other half, the compiler.

Two capabilities matter:

| Capability | Consequence |
| --- | --- |
| `\write18` (shell escape) | Arbitrary command execution |
| `\openin` / `\input` | Arbitrary file read, and the contents land in the compile log the UI displays |

## What is enforced

**Shell escape** is disabled on every platform and every engine: `-no-shell-escape`
for the TeX family, `--untrusted` for Tectonic.

**File reads** are confined with [Landlock](https://landlock.io/) on Linux
(`src-tauri/src/sandbox.rs`). The engine may read the system TeX trees, its own
binary's directory, and the directory the document lives in — so `\input`,
`\includegraphics` and `\bibliography` still resolve — and may write only to a
scratch directory. Everything else, `/etc/passwd` and `~/.ssh` included, is
denied by the kernel.

The policy is applied to a thread, which the engine process then inherits, and
it is verified by tests that assert both what it grants and what it must never
reach.

### Measured, not assumed

Two things were tested rather than taken on trust, and both came back the
opposite of what the documentation implies:

- **`openin_any=p` does nothing on TeX Live 2026.** It is the traditional way to
  stop TeX reading arbitrary files. Upstream turned it into a documented no-op:
  *"as of 2026, openin_any no longer has any effect […] it gave a false sense of
  security."* With it set and `-no-shell-escape` on, `\openin` still read
  `/etc/passwd` straight into the compile log. This is why the restriction is
  applied by the kernel from outside the process instead.
- **Tectonic's `--untrusted` does not block file reads.** It disables shell
  escape — verified — but `\openin` reads `/etc/passwd` identically with and
  without it. It is a supplement to the sandbox, never a substitute.

## Known gaps

**The sandbox is Linux-only.** Landlock is a Linux LSM with no macOS or Windows
equivalent in use here. On those platforms the engine runs unconfined, and a
malicious `.tex` can read files the user can read and surface them in the
compile log. Shell escape is still disabled. When the sandbox is not in force
the compile log says so, and the reason is shown in the UI rather than swallowed.

**The bundled engine is granted network access.** Tectonic fetches its support
files from a remote bundle and cannot work without egress, so `Policy::allow_network`
is set for it and the TLS/DNS resolution files are added to the read set. A
system TeX gets neither. This is a narrower concession than it looks: the
filesystem rules are identical either way, so a document that gains network
still cannot read anything outside the scratch and document directories. The
residual risk is that a document could exfiltrate files *from its own directory*,
which is where its author's material already is.

To avoid it entirely, install a system TeX distribution — it is preferred
automatically when present, and it runs with egress denied.

## Reporting

Open a security advisory on the repository rather than a public issue.
