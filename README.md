# TeX Viewer

A desktop LaTeX editor with a split view: your source on the left, the rendered
document on the right. The right panel has two modes:

- **Live** — an instant, approximate HTML rendering of a useful subset of LaTeX,
  with real math typeset by [KaTeX](https://katex.org/). Updates ~150 ms after
  you stop typing. No TeX installation required.
- **PDF** — the genuine article, produced by running a real LaTeX engine over
  your document and rasterising the result with
  [pdf.js](https://mozilla.github.io/pdf.js/).

Both modes render on the same sheet, in the same typeface, at the same measure:
[Latin Modern](https://www.gust.org.pl/projects/e-foundry/latin-modern), the
face `pdflatex` itself sets. Switching between them compares one document two
ways rather than swapping it for a differently-styled web page.

Built with [Tauri v2](https://tauri.app) (Rust backend), Svelte 5, TypeScript,
Tailwind CSS v4 and CodeMirror 6.

---

## System requirements

| Requirement | Why | Notes |
|---|---|---|
| **webkit2gtk 4.1** | Tauri's Linux webview | Arch: `pacman -S webkit2gtk-4.1`. Verify with `pkg-config --modversion webkit2gtk-4.1`. |
| **Rust** ≥ 1.77.2 | builds the backend | via `rustup` |
| **Node** ≥ 22 + **pnpm** | builds the frontend | |
| **A TeX distribution** | optional | Not required — a [Tectonic](https://tectonic-typesetting.github.io/) engine is bundled. A system TeX is *preferred* when present, because it needs no network and carries your own packages. Arch: `pacman -S texlive-basic texlive-latex texlive-latexrecommended`. |

Nothing above is needed to *install* a release — the installers carry what they
need. That table is for building from source.

### The bundled engine

Installers ship Tectonic, so PDF compilation works on a fresh machine with no
TeX distribution. The engine picker prefers `pdflatex` / `xelatex` / `lualatex`
when one is on `PATH` and falls back to `tectonic` otherwise.

The first compile with the bundled engine downloads the support files your
document needs (~40 s) and caches them under `~/.cache/tectonic`; later compiles
are offline and take well under a second. A system TeX never touches the network.

## Installing

Download an installer from the [releases page](../../releases):

| Platform | File |
|---|---|
| macOS (Apple silicon / Intel) | `.dmg` |
| Windows | `.exe` (NSIS) or `.msi` |
| Debian, Ubuntu | `.deb` |
| Fedora, RHEL, openSUSE | `.rpm` |
| Other Linux | `.AppImage` |
| Any Linux with Flatpak | `.flatpak` — `flatpak install ./dev.joseph.texviewer.flatpak` |

macOS builds are unsigned unless signing secrets are configured, so the first
launch needs **right-click → Open**.

## Running

```sh
pnpm install
pnpm tauri dev
```

The first `pnpm tauri dev` compiles the Rust backend and takes a few minutes;
subsequent runs are fast. Vite serves the frontend on port 1420 with hot reload.

## Building

```sh
# Release binary only, no installer bundles (fastest)
pnpm tauri build --no-bundle
# -> src-tauri/target/release/tex-viewer

# Full build: .deb / .rpm / AppImage on Linux, .dmg on macOS, .msi/.exe on Windows
pnpm tauri build
```

The build fetches the Tectonic sidecar for the target triple first
(`node scripts/fetch-tectonic.mjs`), verifying it against the SHA-256 pinned in
`scripts/tectonic.lock.json`; a mismatch aborts rather than bundling an
unverified compiler. Installers for all three platforms are produced by the
`Release` workflow on a `v*` tag, since they cannot be cross-compiled from one
host.

Build the Flatpak (needs `flatpak` and `flatpak-builder`; wraps the `.deb`, so
build that first):

```sh
pnpm tauri build --bundles deb
./scripts/build-flatpak.sh              # build, install --user, emit the bundle
./scripts/build-flatpak.sh --no-install # bundle only
```

The manifest grants `--share=network` because the bundled engine fetches its
support files on the first compile, and `--filesystem=home` because `\input`,
`\includegraphics` and `\bibliography` resolve against the document's own
directory — a portal file handle only covers the file the user picked, not its
siblings.

If the window comes up blank or fails to start under Wayland, the webview is
hitting a compositor/driver issue rather than an app bug. Force X11 for the
sandbox:

```sh
flatpak override --user --socket=x11 \
  --env=GDK_BACKEND=x11 --env=WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  dev.joseph.texviewer
```

(`--socket=x11` is needed as well as the env vars: the manifest ships
`fallback-x11`, which grants the X socket only when Wayland is absent.)

Regenerate the dependency notice after changing dependencies:

```sh
pnpm licenses     # rewrites THIRD-PARTY-LICENSES.md; CI fails if it is stale
```

Frontend-only checks:

```sh
pnpm build                                    # Vite production build -> dist/
pnpm exec svelte-check --tsconfig ./tsconfig.json   # type + template check
cd src-tauri && cargo check && cargo clippy --all-targets
```

## Keyboard shortcuts

`Ctrl` is `Cmd` on macOS. The global shortcuts only ever fire on a modifier
combination, so they never swallow a keystroke while you are typing.

### Application

| Shortcut | Action |
|---|---|
| `Ctrl+O` | Open a `.tex` file |
| `Ctrl+S` | Save (prompts for a path if the document is untitled) |
| `Ctrl+B` | Compile to PDF and switch to PDF mode |
| `Ctrl+\` | Toggle between Live and PDF mode |
| `Ctrl+Shift+D` | Toggle light / dark theme |

### Editor

| Shortcut | Action |
|---|---|
| `Ctrl+F` | Search, and search & replace |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo (redo is `Cmd+Shift+Z` on macOS) |
| `Ctrl+Space` | Trigger LaTeX autocomplete |
| `Ctrl+/` | Toggle `%` line comment |
| `Tab` | Indent (or accept the selected completion) |
| `Ctrl+Shift+[` / `Ctrl+Shift+]` | Fold / unfold the `\begin…\end` block at the cursor |

Autocomplete offers common commands (sectioning, refs, cites, math macros, Greek
letters) as snippets, and completes environment names inside `\begin{` / `\end{`.

### Split divider

Click the divider to focus it, then:

| Shortcut | Action |
|---|---|
| `←` / `→` | Move by 2% |
| `Shift+←` / `Shift+→` | Move by 10% |
| `Home` / `End` | Jump to the 15% / 85% limit |
| Double-click | Reset to 50% |

The split position, theme and view mode persist across restarts.

## What the live renderer supports

Live mode is a **fast approximation**, not a TeX engine. It is there so you can
see structure and math as you type; compile to PDF for the real layout.

**Document structure**
- Everything before `\begin{document}` is treated as preamble and skipped.
- `\title`, `\author`, `\date` — collected and emitted by `\maketitle`.
- `\section`, `\subsection`, `\subsubsection` (with automatic numbering),
  `\paragraph`. Starred forms are unnumbered.
- Blank-line paragraph breaks; `%` line comments (and `\%` escapes).

**Math** — typeset with KaTeX; a math error renders in red in place rather than
breaking the page.
- Inline: `$…$`, `\(…\)`
- Display: `$$…$$`, `\[…\]`
- Environments: `equation`, `align`, `gather` (numbered, with equation numbers
  down the right margin), their starred forms, and `aligned`.

**Lists** — `itemize`, `enumerate`, `description`, nested to any depth.

**Text formatting** — `\textbf`, `\textit`, `\emph`, `\texttt`, `\underline`,
and the old-style `{\bf …}`, `{\it …}`, `{\tt …}`.

**References** — `\label`, `\ref`, `\eqref`, `\cite`, `\footnote` (rendered as a
backlinked footnote list), `\href`, `\url`. Forward references resolve in a
second pass; a reference to a label that never appears is flagged in red.

**Blocks and floats** — `verbatim`, `lstlisting`, `quote`, `quotation`,
`center`, `figure` and `table` floats with `\caption`, and `tabular` (converted
to a real HTML table, honouring `l` / `c` / `r` column alignment).

**Typographic escapes** — `\&`, `\%`, `\_`, `~`, `---`, `--`, and curly quotes.

**Not supported in live mode** (compile to PDF for these): custom macros
(`\newcommand`), package-specific environments, `\includegraphics`, TikZ,
bibliographies, `\tableofcontents`, page geometry, floats placement, and column
layout.

## Notes on the implementation

- **PDF pages are drawn to `<canvas>`, not shown in an `<iframe>`.** WebKitGTK
  ships no built-in PDF viewer, so an iframe pointed at a PDF renders blank on
  Linux. pdf.js rasterises the pages instead, which behaves identically on every
  platform. pdf.js's CMap tables and standard font programs are mirrored from
  `node_modules` into `public/pdfjs/` by a small plugin in `vite.config.ts`;
  `public/` is generated and gitignored.
- **Compilation runs the engine twice** in a temp directory with
  `-interaction=nonstopmode -halt-on-error`, so cross-references resolve. Each
  pass is killed after 60 s. On failure you get the tail of the combined
  stdout/stderr and `main.log`, never a crash.
- **`tectonic` is deliberately not offered** as an engine. It is easy to detect,
  but it rejects the `-interaction` / `-output-directory` flags the other three
  share, so listing it would only ever produce failing compiles.

## Security

A `.tex` file is treated as untrusted input. Shell escape is disabled on every
platform, and on Linux the engine is confined with a Landlock sandbox so it
cannot read anything outside your document's directory. **The sandbox is
Linux-only** — see [SECURITY.md](SECURITY.md), which also records two measured
findings: TeX Live 2026 made `openin_any` a no-op, and Tectonic's `--untrusted`
does not stop file reads.

## License

Apache-2.0 — see [LICENSE](LICENSE), [NOTICE](NOTICE) and
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md). The bundled Tectonic engine
is MIT; the Latin Modern fonts are under the GUST Font License, whose text
ships with the application as the licence requires.
