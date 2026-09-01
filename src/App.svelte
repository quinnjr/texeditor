<!-- App shell: toolbar + resizable split. OWNER: shell agent. -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Toolbar from './lib/Toolbar.svelte';
  import Editor from './lib/Editor.svelte';
  import Preview from './lib/Preview.svelte';
  import ModeToggle from './lib/ModeToggle.svelte';
  import {
    doc,
    ui,
    build,
    setTheme,
    loadPrefs,
    persistSplitPct,
    persistMode,
    SPLIT_MIN,
    SPLIT_MAX
  } from './lib/stores.svelte';
  import {
    compileLatex,
    openFileDialog,
    saveFile,
    checkEngines,
    asEngine,
    hasTauriRuntime,
    engineNeverRan,
    DesktopOnlyError,
    type LatexEngine
  } from './lib/tauri';

  // Restore persisted theme / split / mode *synchronously during init*, before
  // any $effect is registered. Doing this from onMount would be too late: user
  // effects run in creation order, so the persist effects below would fire
  // first and overwrite localStorage with the defaults we were about to read.
  loadPrefs();

  let engine = $state<LatexEngine>('pdflatex');
  let engines = $state<string[]>([]);

  // Open/Save go through native dialogs, so they only exist in the desktop
  // shell. Under `pnpm dev` in a browser tab the Toolbar greys them out rather
  // than letting a click resolve to nothing.
  const fileAccess = hasTauriRuntime();

  let splitEl: HTMLElement | undefined = $state();
  let dividerEl: HTMLElement | undefined = $state();
  let dragging = $state(false);

  // Identifies the document currently in the buffer. Every async command that
  // outlives its own call (compile, save) captures this before awaiting and
  // re-checks it afterwards: the webview stays live across an IPC round-trip,
  // so by the time a result lands the buffer may hold a *different* document
  // and applying the result would attach one document's output to another.
  // Bumped by newDocumentGeneration() wherever the buffer is replaced wholesale.
  let docGeneration = 0;
  function newDocumentGeneration() {
    docGeneration += 1;
  }

  // Open and Save both hand control to a native dialog that can stay up
  // indefinitely. Ctrl+S / Ctrl+O are bound to a raw keydown handler, which
  // fires on auto-repeat (~30 times a second while held), so without these
  // guards a held key stacks one dialog per repeat — each writing the buffer to
  // whatever path it returned. This is the same protection `build.compiling`
  // already gives compile().
  let saving = false;
  let opening = false;

  function clampSplit(pct: number) {
    return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct));
  }

  /** Drop the current PDF object URL, if any, so the blob can be collected. */
  function releasePdf() {
    if (build.pdfUrl) {
      URL.revokeObjectURL(build.pdfUrl);
      build.pdfUrl = null;
    }
  }

  async function compile() {
    if (build.compiling) return;
    // Same gate the Compile button uses (`build.compiling || engines.length === 0`).
    // It lives here rather than only on the button so the Ctrl+B shortcut can't
    // route around it and end up blaming a LaTeX engine that was never invoked.
    if (engines.length === 0) {
      ui.status = fileAccess
        ? 'No LaTeX engine found — install pdflatex, xelatex or lualatex'
        : 'Compiling requires the desktop app';
      return;
    }
    build.compiling = true;
    build.error = null;
    build.log = '';
    ui.status = 'Compiling…';
    // A compile can run for many seconds; the document can be replaced (Open)
    // while it does. Anything this run produces belongs to `generation`, so
    // none of it may be applied once the buffer has moved on — otherwise the
    // old document's PDF gets shown, in PDF mode, next to the new source and
    // labelled a success.
    const generation = docGeneration;
    try {
      // `doc.path` names the currently-open document (null for an untitled
      // buffer) so the engine can resolve \input, \includegraphics and
      // \bibliography relative to it — see compile_latex's `doc_path` param.
      const result = await compileLatex(doc.source, engine, doc.path);
      // Checked before the blob/object URL is built, so a discarded result
      // never allocates a URL that nothing would revoke.
      if (generation !== docGeneration) return;
      build.log = result.log;
      if (result.ok && result.pdfBytes) {
        const blob = new Blob([result.pdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        releasePdf();
        build.pdfUrl = url;
        build.error = null;
        ui.mode = 'pdf';
        ui.status = 'Compiled successfully';
      } else if (!result.log) {
        build.error = 'Compilation failed';
        ui.mode = 'pdf';
        ui.status = 'Compile failed';
      } else if (engineNeverRan(result.log)) {
        // The binary never started (missing from PATH, unsupported engine, or
        // no desktop shell at all) — say so instead of pinning it on TeX.
        build.error = `Could not run ${engine} — see the log below.`;
        ui.mode = 'pdf';
        ui.status = 'Engine unavailable';
      } else {
        build.error = 'The engine reported errors — see the log below.';
        ui.mode = 'pdf';
        ui.status = 'Compile failed';
      }
    } catch (e) {
      // A failure that belongs to a document nobody is looking at any more is
      // just as misleading as a stale success.
      if (generation !== docGeneration) return;
      build.error = e instanceof Error ? e.message : String(e);
      ui.mode = 'pdf';
      ui.status = 'Compile error';
    } finally {
      // Only ever one compile in flight (guarded above), so this always
      // belongs to the run that set it — including on the stale-return paths.
      build.compiling = false;
    }
  }

  /**
   * Native yes/no dialog, with the browser's confirm() as the `pnpm dev`
   * fallback. Returns true when the user chose to go ahead.
   */
  async function confirmDiscard(message: string, okLabel: string): Promise<boolean> {
    if (hasTauriRuntime()) {
      try {
        const { ask } = await import('@tauri-apps/plugin-dialog');
        return await ask(message, {
          title: 'Unsaved changes',
          kind: 'warning',
          okLabel,
          cancelLabel: 'Keep editing'
        });
      } catch {
        // Dialog plugin unavailable — fall through to the browser prompt.
      }
    }
    return window.confirm(message);
  }

  async function doOpen() {
    // Bail before the discard prompt when there is no dialog to open anyway,
    // so a browser tab never asks about unsaved work for nothing.
    if (!fileAccess) {
      ui.status = 'Opening files requires the desktop app';
      return;
    }
    // Held Ctrl+O would otherwise stack a discard prompt *and* a file dialog
    // per auto-repeat.
    if (opening) return;
    opening = true;
    try {
      await runOpen();
    } finally {
      opening = false;
    }
  }

  async function runOpen() {
    // Opening replaces the buffer outright, so unsaved edits would disappear
    // with no prompt — and CodeMirror's history would still hold them, so a
    // later Ctrl+Z could paste them into the *newly opened* file and Ctrl+S
    // would write them over it. Ask first; the editor drops its history when
    // the new document lands.
    if (doc.dirty) {
      const discard = await confirmDiscard(
        'Your document has unsaved changes. Open another file and discard them?',
        'Discard changes'
      );
      if (!discard) {
        ui.status = 'Open cancelled — unsaved changes kept';
        return;
      }
    }
    try {
      const result = await openFileDialog();
      if (!result) return;
      // The buffer is about to become a different document: invalidate every
      // in-flight command that captured the old one.
      newDocumentGeneration();
      doc.source = result.content;
      doc.path = result.path;
      doc.dirty = false;
      // The old PDF belongs to the old document; don't leave it on screen.
      releasePdf();
      build.error = null;
      build.log = '';
      ui.mode = 'live';
      ui.status = `Opened ${result.path}`;
    } catch (e) {
      // A DesktopOnlyError isn't a failure, it's an unsupported environment —
      // report it plainly rather than as "Open failed: …".
      ui.status =
        e instanceof DesktopOnlyError
          ? e.message
          : `Open failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function doSave() {
    // Untitled documents route through a native Save-As dialog, so a held
    // Ctrl+S would otherwise open one dialog per auto-repeat, scattering the
    // buffer across every path the user (or the stack of dialogs) resolved and
    // leaving doc.path on whichever finished last.
    if (saving) return;
    saving = true;
    // save_file is async and the webview keeps running during the round-trip,
    // so Editor's updateListener can push new characters into doc.source before
    // it resolves. Only `snapshot` reaches disk — clearing doc.dirty for text
    // typed afterwards would strand those characters: the dot goes clean, and
    // the close guard (`if (!doc.dirty) return`) then destroys the window
    // without a prompt.
    const snapshot = doc.source;
    const generation = docGeneration;
    try {
      const finalPath = await saveFile(doc.path, snapshot);
      if (finalPath) {
        // If the buffer was replaced mid-save, `finalPath` names where the
        // *previous* document went; adopting it would point the new document's
        // next save at the old file.
        if (generation !== docGeneration) {
          ui.status = `Saved ${finalPath}`;
          return;
        }
        doc.path = finalPath;
        if (doc.source === snapshot) {
          doc.dirty = false;
          ui.status = `Saved ${finalPath}`;
        } else {
          // Everything up to the snapshot is on disk, but the buffer has moved
          // past it — stay dirty so the close guard still prompts.
          ui.status = `Saved ${finalPath} — edits made during the save are still unsaved`;
        }
      }
    } catch (e) {
      // Ditto: outside the desktop shell nothing was even attempted, and
      // doc.dirty deliberately stays set.
      ui.status =
        e instanceof DesktopOnlyError
          ? e.message
          : `Save failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      saving = false;
    }
  }

  function setMode(mode: 'live' | 'pdf') {
    ui.mode = mode;
  }

  function toggleMode() {
    ui.mode = ui.mode === 'live' ? 'pdf' : 'live';
  }

  function toggleTheme() {
    setTheme(ui.theme === 'dark' ? 'light' : 'dark');
  }

  function onEngineChange(next: string) {
    const narrowed = asEngine(next, engines);
    if (narrowed) engine = narrowed;
  }

  // --- Divider drag (mouse + touch via Pointer Events) ------------------
  // `flex: 0 0 <pct>%` sizes the left pane against the *container* width, so
  // the divider's left edge lands at pct% of that width. To keep the divider
  // centred under the cursor we subtract half its own width before converting
  // back to a percentage — otherwise the divider visibly jumps by ~3px the
  // moment a drag starts.
  function updateFromClientX(clientX: number) {
    if (!splitEl) return;
    const rect = splitEl.getBoundingClientRect();
    if (rect.width === 0) return;
    const dividerW = dividerEl?.getBoundingClientRect().width ?? 0;
    const pct = ((clientX - rect.left - dividerW / 2) / rect.width) * 100;
    ui.splitPct = clampSplit(pct);
  }

  function onDividerPointerDown(e: PointerEvent) {
    dragging = true;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onDividerPointerMove(e: PointerEvent) {
    if (!dragging) return;
    updateFromClientX(e.clientX);
  }

  function onDividerPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const target = e.currentTarget as Element;
    if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId);
  }

  function onDividerKeydown(e: KeyboardEvent) {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') {
      ui.splitPct = clampSplit(ui.splitPct - step);
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      ui.splitPct = clampSplit(ui.splitPct + step);
      e.preventDefault();
    } else if (e.key === 'Home') {
      ui.splitPct = SPLIT_MIN;
      e.preventDefault();
    } else if (e.key === 'End') {
      ui.splitPct = SPLIT_MAX;
      e.preventDefault();
    }
  }

  function resetSplit() {
    ui.splitPct = 50;
  }

  // Persist split/mode whenever they change. splitPct changes once per pointer
  // frame while dragging, and localStorage.setItem is a synchronous, disk-backed
  // write — so coalesce it instead of writing 100+ times a second.
  let splitPersistHandle: ReturnType<typeof setTimeout> | undefined;
  function flushSplitPct() {
    clearTimeout(splitPersistHandle);
    persistSplitPct(ui.splitPct);
  }
  $effect(() => {
    const pct = ui.splitPct;
    clearTimeout(splitPersistHandle);
    splitPersistHandle = setTimeout(() => persistSplitPct(pct), 200);
  });
  $effect(() => {
    persistMode(ui.mode);
  });

  onMount(() => {
    (async () => {
      try {
        const list = await checkEngines();
        engines = list;
        if (list.length > 0 && !list.includes(engine)) {
          const first = asEngine(list[0], list);
          if (first) engine = first;
        }
      } catch {
        // No engines detected — the compile button stays disabled.
      }
    })();

    // Global shortcuts only ever intercept a Ctrl/Cmd combo, never a bare
    // key, so they can never eat a character while someone is typing in
    // the editor or anywhere else.
    function handleKeydown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      let action: (() => void) | null = null;
      if (e.shiftKey && key === 'd') {
        action = toggleTheme;
      } else if (e.shiftKey) {
        // Leave every other Shift+Mod combo (Shift+Ctrl+Z redo, etc.) alone.
        return;
      } else if (key === 's') {
        action = () => void doSave();
      } else if (key === 'o') {
        action = () => void doOpen();
      } else if (key === 'b') {
        action = () => void compile();
      } else if (key === '\\') {
        action = toggleMode;
      } else {
        return;
      }
      // Swallow the combo on every event, including the repeats we drop below,
      // so a held Ctrl+S can't reach the webview's own handler for it.
      e.preventDefault();
      // Holding a key fires keydown ~30 times a second. None of these commands
      // mean anything repeated — Save and Open would each queue a native dialog,
      // and the toggles would strobe — so only the first event acts.
      if (e.repeat) return;
      action();
    }
    window.addEventListener('keydown', handleKeydown);

    // `beforeunload` never fires in the Tauri window — WebKitGTK's
    // run-beforeunload-confirm signal is not wired up by wry, and closing a
    // native window destroys the webview rather than unloading the document.
    // Keep this handler purely as the `pnpm dev` browser-tab fallback; the real
    // desktop guard is onCloseRequested below.
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      // The debounced write above may still be pending; the window closing is
      // the one moment we can't afford to drop it.
      flushSplitPct();
      if (doc.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);

    // --- Native close guard --------------------------------------------
    // Tauri suppresses the native close as soon as a JS listener for
    // WINDOW_CLOSE_REQUESTED exists, emits the event, and destroys the window
    // itself once our handler returns without calling preventDefault().
    let disposed = false;
    let unlistenClose: (() => void) | null = null;

    if (fileAccess) {
      (async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const appWindow = getCurrentWindow();
          const unlisten = await appWindow.onCloseRequested(async (event) => {
            // Same reasoning as beforeunload: this is the last chance to land
            // the debounced split-position write.
            flushSplitPct();
            if (!doc.dirty) return;

            event.preventDefault();
            const discard = await confirmDiscard(
              'Your document has unsaved changes. Close without saving?',
              'Discard changes'
            );
            if (discard) {
              // preventDefault() already stopped the automatic destroy, so the
              // window has to be torn down explicitly.
              doc.dirty = false;
              releasePdf();
              await appWindow.destroy();
            }
          });
          // The component may have unmounted while those imports were in flight.
          if (disposed) unlisten();
          else unlistenClose = unlisten;
        } catch {
          // Falling through leaves the window closing without a prompt, which is
          // exactly the pre-existing behaviour — never block shutdown on this.
        }
      })();
    }

    return () => {
      disposed = true;
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      unlistenClose?.();
    };
  });

  onDestroy(() => {
    flushSplitPct();
    releasePdf();
  });
</script>

<div class="flex h-full w-full flex-col bg-bg text-fg">
  <Toolbar
    {engine}
    {engines}
    {onEngineChange}
    {fileAccess}
    onOpen={doOpen}
    onSave={doSave}
    onCompile={compile}
    {setMode}
    {toggleTheme}
  />

  <main bind:this={splitEl} class="flex min-h-0 flex-1 overflow-hidden">
    <section class="flex min-h-0 min-w-0 flex-col overflow-hidden" style="flex: 0 0 {ui.splitPct}%">
      <div
        class="flex h-9 shrink-0 items-center border-b border-edge bg-surface-alt px-3 text-xs font-medium tracking-wide text-fg-muted uppercase"
      >
        Source
      </div>
      <div class="min-h-0 flex-1 overflow-hidden">
        <Editor />
      </div>
    </section>

    <!-- The ARIA "window splitter" pattern is role="separator" + tabindex
         with its own keyboard/pointer handling; generic a11y linting
         flags it as a non-interactive element, but this is the correct
         accessible shape for a resizable divider. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={dividerEl}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize editor and preview panels"
      aria-valuenow={Math.round(ui.splitPct)}
      aria-valuemin={SPLIT_MIN}
      aria-valuemax={SPLIT_MAX}
      tabindex="0"
      class="relative w-1.5 shrink-0 cursor-col-resize touch-none bg-edge transition-colors hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none {dragging
        ? 'bg-accent'
        : ''}"
      onpointerdown={onDividerPointerDown}
      onpointermove={onDividerPointerMove}
      onpointerup={onDividerPointerUp}
      onpointercancel={onDividerPointerUp}
      ondblclick={resetSplit}
      onkeydown={onDividerKeydown}
    ></div>

    <section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        class="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-surface-alt px-3 text-xs font-medium tracking-wide text-fg-muted uppercase"
      >
        <span>Preview</span>
        <ModeToggle
          mode={ui.mode}
          {setMode}
          size="sm"
          wrapperClass="ml-auto bg-bg font-normal tracking-normal normal-case"
        />
      </div>
      <div class="min-h-0 flex-1 overflow-hidden">
        <Preview />
      </div>
    </section>
  </main>

  <footer class="flex h-6 shrink-0 items-center gap-3 border-t border-edge bg-surface px-3 text-xs text-fg-muted">
    <span class="truncate">{ui.status}</span>
    {#if build.error}
      <span class="text-danger">Build error — see log</span>
    {/if}
    <span class="ml-auto">{engine || 'no engine'}</span>
  </footer>
</div>
