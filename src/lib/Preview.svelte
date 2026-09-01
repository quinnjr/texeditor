<!-- Right panel: rendered output (live HTML/KaTeX or compiled PDF). OWNER: preview agent. -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { doc, ui, build } from './stores.svelte';
  import { renderLatex } from './preview/render';
  import { loadPdf, type PdfHandle } from './preview/pdf';

  let renderedHtml = $state('<div class="tex-doc-root"></div>');
  let mathCount = $state(0);
  let wordCount = $state(0);
  let logCopied = $state(false);

  let contentEl: HTMLElement | undefined = $state();
  let debounceHandle: ReturnType<typeof setTimeout> | undefined;

  function doRender() {
    const result = renderLatex(doc.source);
    renderedHtml = result.html;
    mathCount = result.mathCount;
  }

  $effect(() => {
    // touch doc.source so this effect re-runs whenever it changes
    const _src = doc.source;
    if (debounceHandle) clearTimeout(debounceHandle);
    debounceHandle = setTimeout(() => {
      doRender();
    }, 150);
    return () => {
      if (debounceHandle) clearTimeout(debounceHandle);
    };
  });

  // Recompute the word count whenever the rendered HTML (and thus the DOM)
  // changes *or* the live pane is (re)mounted.
  //
  // Tracking `contentEl` matters for the same reason it does for `pagesEl` in the
  // PDF loader below: the shell lives inside the {#if ui.mode === 'live'} branch,
  // and `ui.mode` is restored from localStorage, so a session that ended in PDF
  // mode reopens with the branch unmounted. Reading `contentEl` only inside the
  // queueMicrotask callback would not register it as a dependency — by the time
  // that callback runs Svelte has cleared the active reaction — so switching back
  // to Live would never re-run this and the footer would sit at "0 words" until
  // the next keystroke.
  $effect(() => {
    void renderedHtml;
    const el = contentEl;
    if (!el) return;
    queueMicrotask(() => {
      const text = el.textContent ?? '';
      const words = text.trim().split(/\s+/).filter(Boolean);
      wordCount = words.length;
    });
  });

  // ---- PDF mode ---------------------------------------------------------
  // Rendered to <canvas> via pdf.js rather than handed to an <iframe>: the app
  // runs on webkit2gtk, which has no built-in PDF viewer, so an iframe would
  // show nothing at all.

  const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

  let pagesEl: HTMLElement | undefined = $state();
  let pdfScrollEl: HTMLElement | undefined = $state();
  let zoom = $state(1);
  let pageCount = $state(0);
  let pdfLoading = $state(false);
  let pdfError = $state<string | null>(null);
  let availableWidth = $state(0);

  let handle: PdfHandle | null = null;
  /** Bumped on every load so a slow load can't clobber a newer one. */
  let loadToken = 0;

  async function disposeHandle() {
    const current = handle;
    handle = null;
    pageCount = 0;
    if (current) await current.destroy();
  }

  function zoomIn() {
    const next = ZOOM_STEPS.find((z) => z > zoom + 1e-6);
    if (next !== undefined) zoom = next;
  }

  function zoomOut() {
    const lower = ZOOM_STEPS.filter((z) => z < zoom - 1e-6);
    if (lower.length > 0) zoom = lower[lower.length - 1];
  }

  function zoomReset() {
    zoom = 1;
  }

  // Track the width the pages may occupy, so "fit width" actually fits.
  $effect(() => {
    const el = pdfScrollEl;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Subtract the gutter the CSS pads the page column with.
        availableWidth = Math.max(0, entry.contentRect.width - 32);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  // Load whenever the compiled PDF changes *or* the page container is rebound.
  //
  // Tracking `pagesEl` matters: the container lives inside an {#if} branch, so
  // switching Live -> PDF -> Live -> PDF destroys and recreates it. Depending on
  // build.pdfUrl alone, the second visit would leave the canvases orphaned in a
  // detached div and the panel would come up blank.
  //
  // Deliberately does *not* read availableWidth/zoom, so resizing and zooming
  // re-rasterise through the effect below without re-parsing the document.
  $effect(() => {
    const url = build.pdfUrl;
    const container = pagesEl;
    const token = ++loadToken;

    if (!url || !container) {
      pdfLoading = false;
      // Only a genuinely absent document resets the error. Clearing it just
      // because the container unmounted would remount the branch, retry, fail
      // and unmount again — an endless flip-flop.
      if (!url) pdfError = null;
      void disposeHandle();
      return;
    }

    pdfLoading = true;
    pdfError = null;

    (async () => {
      await disposeHandle();
      if (token !== loadToken) return;
      try {
        const next = await loadPdf(url, container);
        if (token !== loadToken) {
          await next.destroy();
          return;
        }
        handle = next;
        pageCount = next.pageCount;
      } catch (err) {
        if (token !== loadToken) return;
        pdfError = err instanceof Error ? err.message : String(err);
      } finally {
        if (token === loadToken) pdfLoading = false;
      }
    })();
  });

  // Rasterise (and re-rasterise) at the current width and zoom. Reads only
  // pageCount / availableWidth / zoom — never writes them — so it settles.
  $effect(() => {
    const pages = pageCount;
    const width = availableWidth;
    const z = zoom;
    if (pages === 0 || width === 0) return;

    const current = handle;
    if (!current) return;

    let cancelled = false;
    current.draw({ availableWidth: width, zoom: z }).catch((err) => {
      if (cancelled) return;
      pdfError = err instanceof Error ? err.message : String(err);
    });
    return () => {
      cancelled = true;
    };
  });

  onDestroy(() => {
    if (debounceHandle) clearTimeout(debounceHandle);
    loadToken++;
    void disposeHandle();
  });

  async function copyLog() {
    try {
      await navigator.clipboard.writeText(build.log);
      logCopied = true;
      setTimeout(() => (logCopied = false), 1500);
    } catch {
      // clipboard API unavailable; nothing more we can do
    }
  }

  function logTail(log: string, lines = 60): string {
    const all = log.split('\n');
    if (all.length <= lines) return log;
    return all.slice(-lines).join('\n');
  }
</script>

<div class="flex h-full w-full flex-col overflow-hidden bg-surface-alt text-fg">
  {#if ui.mode === 'live'}
    <div class="min-h-0 flex-1 overflow-auto">
      <div class="tex-preview-shell" bind:this={contentEl}>
        {@html renderedHtml}
      </div>
    </div>
    <footer
      class="flex h-7 shrink-0 items-center gap-4 border-t border-edge bg-surface px-3 text-xs text-fg-muted"
    >
      <span>{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>
      <span>{mathCount} {mathCount === 1 ? 'math block' : 'math blocks'}</span>
    </footer>
  {:else}
    <div class="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {#if build.error}
        <div class="flex h-full flex-col gap-3 overflow-auto p-4">
          <div class="flex items-center gap-3">
            <span class="text-sm font-semibold text-danger">Compilation failed</span>
            <button
              class="ml-auto rounded border border-edge bg-surface px-2 py-1 text-xs text-fg hover:bg-surface-alt"
              onclick={copyLog}
            >
              {logCopied ? 'Copied' : 'Copy log'}
            </button>
          </div>
          <p class="text-sm text-fg">{build.error}</p>
          <pre
            class="flex-1 overflow-auto rounded border border-edge bg-surface p-3 font-mono text-xs whitespace-pre-wrap text-fg"
          >{logTail(build.log)}</pre>
        </div>
      {:else if build.pdfUrl}
        <div class="flex h-8 shrink-0 items-center gap-1 border-b border-edge bg-surface px-2 text-xs">
          <button
            class="rounded px-2 py-0.5 text-fg-muted hover:bg-surface-alt hover:text-fg disabled:opacity-40"
            onclick={zoomOut}
            disabled={zoom <= ZOOM_STEPS[0]}
            title="Zoom out"
            aria-label="Zoom out">&minus;</button
          >
          <button
            class="min-w-[3.5rem] rounded px-2 py-0.5 tabular-nums text-fg-muted hover:bg-surface-alt hover:text-fg"
            onclick={zoomReset}
            title="Reset zoom to fit width">{Math.round(zoom * 100)}%</button
          >
          <button
            class="rounded px-2 py-0.5 text-fg-muted hover:bg-surface-alt hover:text-fg disabled:opacity-40"
            onclick={zoomIn}
            disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            title="Zoom in"
            aria-label="Zoom in">+</button
          >
          <span class="ml-auto text-fg-muted">
            {pageCount} {pageCount === 1 ? 'page' : 'pages'}
          </span>
        </div>
        {#if pdfError}
          <div class="shrink-0 border-b border-edge bg-surface px-3 py-2 text-xs">
            <span class="font-semibold text-danger">Could not display the PDF.</span>
            <span class="text-fg-muted">{pdfError}</span>
          </div>
        {/if}
        <div class="min-h-0 flex-1 overflow-auto" bind:this={pdfScrollEl}>
          <div class="tex-pdf-pages" bind:this={pagesEl}></div>
        </div>
      {:else}
        <div class="flex h-full items-center justify-center text-sm text-fg-muted">
          No PDF yet. Compile the document to see output here.
        </div>
      {/if}
      {#if build.compiling || pdfLoading}
        <div class="absolute inset-0 flex items-center justify-center bg-bg/60 backdrop-blur-sm">
          <div class="flex flex-col items-center gap-3">
            <div class="tex-spinner"></div>
            <span class="text-sm text-fg-muted">{build.compiling ? 'Compiling…' : 'Rendering…'}</span>
          </div>
        </div>
      {/if}
    </div>
    <footer
      class="flex h-7 shrink-0 items-center gap-4 border-t border-edge bg-surface px-3 text-xs text-fg-muted"
    >
      <span
        >{build.compiling
          ? 'Compiling…'
          : build.error
            ? 'Compile failed'
            : pdfError
              ? 'Render failed'
              : build.pdfUrl
                ? 'PDF output'
                : 'No PDF yet'}</span
      >
    </footer>
  {/if}
</div>

<style>
  .tex-spinner {
    width: 2rem;
    height: 2rem;
    border-radius: 9999px;
    border: 3px solid var(--app-border);
    border-top-color: var(--app-accent);
    animation: tex-spin 0.8s linear infinite;
  }

  @keyframes tex-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .tex-pdf-pages {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 1rem;
    min-width: min-content;
  }

  :global(.tex-pdf-page) {
    display: block;
    background: #ffffff;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.2), 0 6px 18px rgb(0 0 0 / 0.14);
    border-radius: 2px;
  }

  .tex-preview-shell {
    padding: 2.5rem 1.5rem 4rem;
    max-width: 100%;
  }

  /* ---- Rendered-document typography ---------------------------------
     The document body is injected via {@html}, so Svelte's normal scoped
     styles can't reach it - everything below is wrapped in :global() and
     namespaced under .tex-doc-root to keep it from leaking into the rest
     of the app shell.                                                   */
  :global(.tex-doc-root) {
    max-width: 42rem;
    margin: 0 auto;
    font-family: 'Georgia', 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif;
    font-size: 0.98rem;
    line-height: 1.7;
    color: var(--app-fg);
  }

  :global(.tex-title-block) {
    text-align: center;
    margin: 0 0 2.5rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--app-border);
  }
  :global(.tex-title) {
    font-size: 1.9rem;
    font-weight: 600;
    line-height: 1.25;
    margin: 0 0 0.6rem;
  }
  :global(.tex-author) {
    font-size: 1.05rem;
    color: var(--app-fg-muted);
    margin: 0 0 0.25rem;
  }
  :global(.tex-date) {
    font-size: 0.9rem;
    color: var(--app-fg-muted);
  }

  :global(.tex-heading) {
    font-weight: 600;
    line-height: 1.3;
    margin: 1.8em 0 0.6em;
    scroll-margin-top: 1rem;
  }
  :global(.tex-heading:first-child) {
    margin-top: 0;
  }
  :global(.tex-section) {
    font-size: 1.4rem;
    padding-bottom: 0.3rem;
    border-bottom: 1px solid var(--app-border);
  }
  :global(.tex-subsection) {
    font-size: 1.18rem;
  }
  :global(.tex-subsubsection) {
    font-size: 1.04rem;
  }
  :global(.tex-secnum) {
    color: var(--app-accent);
    margin-right: 0.55em;
    font-variant-numeric: tabular-nums;
  }

  :global(.tex-p) {
    margin: 0 0 1em;
    text-align: justify;
    hyphens: auto;
  }

  :global(.tex-list) {
    margin: 0 0 1em;
    padding-left: 1.5em;
  }
  :global(.tex-ul) {
    list-style: disc;
  }
  :global(.tex-ol) {
    list-style: decimal;
  }
  :global(.tex-li) {
    margin: 0.25em 0;
  }
  :global(.tex-li > .tex-p:last-child) {
    margin-bottom: 0;
  }
  :global(.tex-description) {
    margin: 0 0 1em;
  }
  :global(.tex-dt) {
    font-weight: 600;
    margin-top: 0.5em;
  }
  :global(.tex-dd) {
    margin: 0.15em 0 0 1.5em;
  }

  :global(.tex-quote) {
    margin: 1em 0 1em 0;
    padding: 0.2em 1em;
    border-left: 3px solid var(--app-border);
    color: var(--app-fg-muted);
    font-style: italic;
  }
  :global(.tex-center) {
    text-align: center;
  }

  :global(.tex-figure) {
    margin: 1.5em 0;
    text-align: center;
  }
  :global(.tex-caption) {
    margin-top: 0.5em;
    font-size: 0.88rem;
    color: var(--app-fg-muted);
    text-align: left;
  }
  :global(.tex-caption-label) {
    font-weight: 600;
    color: var(--app-fg);
  }

  :global(.tex-table-wrap) {
    overflow-x: auto;
    margin: 1em 0;
  }
  :global(.tex-table) {
    border-collapse: collapse;
    margin: 0 auto;
    font-size: 0.92rem;
  }
  :global(.tex-table td) {
    border: 1px solid var(--app-border);
    padding: 0.35em 0.75em;
  }

  :global(.tex-code),
  :global(.tex-verbatim) {
    display: block;
    margin: 1em 0;
    padding: 0.75em 1em;
    background: var(--app-surface);
    border: 1px solid var(--app-border);
    border-radius: 0.375rem;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 0.85rem;
    line-height: 1.5;
    white-space: pre;
    text-align: left;
  }
  :global(.tex-doc-root code) {
    font-family: var(--font-mono);
    font-size: 0.88em;
    background: var(--app-surface);
    padding: 0.1em 0.3em;
    border-radius: 0.25em;
  }
  :global(.tex-code code),
  :global(.tex-verbatim code) {
    background: transparent;
    padding: 0;
  }

  :global(.tex-link) {
    color: var(--app-accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  :global(.tex-ref) {
    color: var(--app-accent);
    text-decoration: none;
  }
  :global(.tex-ref-pending) {
    color: var(--app-danger);
  }
  :global(.tex-cite) {
    color: var(--app-accent);
  }
  :global(.tex-label-anchor) {
    scroll-margin-top: 1rem;
  }

  :global(.tex-fn-rule) {
    margin: 2.5em 0 1em;
    border: none;
    border-top: 1px solid var(--app-border);
  }
  :global(.tex-footnotes) {
    font-size: 0.85rem;
    color: var(--app-fg-muted);
    padding-left: 1.4em;
  }
  :global(.tex-footnotes li) {
    margin: 0.35em 0;
  }
  :global(.tex-fn-ref a),
  :global(.tex-fn-back) {
    color: var(--app-accent);
    text-decoration: none;
  }

  :global(.tex-math-error) {
    color: var(--app-danger);
    font-family: var(--font-mono);
  }
  :global(.tex-render-error) {
    color: var(--app-danger);
    font-family: var(--font-mono);
    white-space: pre-wrap;
  }

  :global(.tex-eqn-row) {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1em;
    margin: 0.2em 0;
  }
  :global(.tex-eqn-math) {
    flex: 1;
    overflow-x: auto;
  }
  :global(.tex-eqn-num) {
    flex: 0 0 auto;
    color: var(--app-fg-muted);
    font-variant-numeric: tabular-nums;
  }

  :global(.tex-doc-root .katex-display) {
    margin: 0.6em 0;
    overflow-x: auto;
    overflow-y: hidden;
  }
</style>
