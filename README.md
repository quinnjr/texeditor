# TeX Viewer

A desktop LaTeX editor with a split view: your source on the left, the rendered
document on the right. The right panel has two modes:

- **Live** — an instant, approximate HTML rendering of a useful subset of LaTeX,
  with real math typeset by [KaTeX](https://katex.org/). Updates ~150 ms after
  you stop typing. No TeX installation required.
- **PDF** — the genuine article, produced by running `pdflatex` / `xelatex` /
  `lualatex` over your document and rasterising the result with
  [pdf.js](https://mozilla.github.io/pdf.js/).

Built with [Tauri v2](https://tauri.app) (Rust backend), Svelte 5, TypeScript,
Tailwind CSS v4 and CodeMirror 6.

---

## System requirements

| Requirement | Why | Notes |
|---|---|---|
| **webkit2gtk 4.1** | Tauri's Linux webview | Arch: `pacman -S webkit2gtk-4.1`. Verify with `pkg-config --modversion webkit2gtk-4.1`. |
| **Rust** ≥ 1.77.2 | builds the backend | via `rustup` |
| **Node** ≥ 22 + **pnpm** | builds the frontend | |
| **A TeX distribution** | **PDF mode only** | TeX Live or similar, providing at least one of `pdflatex`, `xelatex`, `lualatex` on `PATH`. Arch: `pacman -S texlive-basic texlive-latex texlive-latexrecommended`. |

Live mode works with no TeX installed at all. If no engine is found on `PATH`,
the engine picker reads *No engine found* and the **Compile** button is disabled;
everything else still works.

The sample document also uses `geometry`, `amsmath`, `amssymb` and `booktabs`;
on a minimal TeX Live install you may need `texlive-latexextra` for `booktabs`.

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

# Full build, including .deb / .rpm / AppImage
pnpm tauri build
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
