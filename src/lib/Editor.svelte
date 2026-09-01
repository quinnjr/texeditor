<!-- Left panel: LaTeX source editor (CodeMirror 6). OWNER: editor agent. -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    drawSelection,
    rectangularSelection,
    crosshairCursor
  } from '@codemirror/view';
  import { EditorState, Compartment, type Extension } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
  import {
    bracketMatching,
    foldGutter,
    foldKeymap,
    indentOnInput,
    indentUnit,
    syntaxHighlighting
  } from '@codemirror/language';
  import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
  import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
  import { oneDark } from '@codemirror/theme-one-dark';
  import { doc, ui } from './stores.svelte';
  import { latex, latexHighlightStyle } from './editor/latex-language';
  import { latexCompletions } from './editor/latex-completions';

  let hostEl: HTMLDivElement;
  let view: EditorView | undefined;

  /** Swaps the base UI theme (light EditorView.theme <-> one-dark) without rebuilding the editor. */
  const themeCompartment = new Compartment();

  /** Holds the undo history so it can be thrown away when a different document is loaded. */
  const historyCompartment = new Compartment();

  /** True while an *external* doc.source change is being pushed into CodeMirror, so the
   *  update listener below does not mistake it for a user edit and mark the doc dirty. */
  let applyingExternal = false;

  const lightTheme = EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'var(--app-surface, #ffffff)',
        color: 'var(--app-fg, #1b1b19)',
        '--cm-latex-comment': '#6b7280',
        '--cm-latex-escape': '#b5651d',
        '--cm-latex-command': '#af00db',
        '--cm-latex-env': '#267f99',
        '--cm-latex-math': '#0550ae',
        '--cm-latex-mathvar': '#1a56b0',
        '--cm-latex-brace': '#57534e',
        '--cm-latex-op': '#d73a49',
        '--cm-latex-number': '#098658',
        '--cm-latex-heading': '#005cc5'
      },
      '.cm-content': { caretColor: 'var(--app-accent, #2f6feb)' },
      '.cm-cursor': { borderLeftColor: 'var(--app-accent, #2f6feb)' },
      '.cm-scroller': { fontFamily: 'var(--font-mono, ui-monospace, monospace)', lineHeight: '1.5' },
      '.cm-gutters': {
        backgroundColor: 'var(--app-surface-alt, #f1f1ef)',
        color: 'var(--app-fg-muted, #6b6b66)',
        border: 'none',
        borderRight: '1px solid var(--app-border, #d9d9d5)'
      },
      '.cm-activeLine': { backgroundColor: 'rgba(47, 111, 235, 0.06)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgba(47, 111, 235, 0.10)' },
      '.cm-selectionMatch': { backgroundColor: 'rgba(255, 196, 0, 0.35)' },
      '.cm-foldPlaceholder': {
        backgroundColor: 'var(--app-surface-alt, #f1f1ef)',
        border: '1px solid var(--app-border, #d9d9d5)',
        color: 'var(--app-fg-muted, #6b6b66)'
      },
      '&.cm-focused': { outline: 'none' },
      '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(47, 111, 235, 0.25)' }
    },
    { dark: false }
  );

  const darkAccent = EditorView.theme(
    {
      '&': {
        height: '100%',
        '--cm-latex-comment': '#8b93a8',
        '--cm-latex-escape': '#d19a66',
        '--cm-latex-command': '#c678dd',
        '--cm-latex-env': '#56b6c2',
        '--cm-latex-math': '#61afef',
        '--cm-latex-mathvar': '#79b8ff',
        '--cm-latex-brace': '#abb2bf',
        '--cm-latex-op': '#e06c75',
        '--cm-latex-number': '#98c379',
        '--cm-latex-heading': '#61afef'
      },
      '.cm-activeLine': { backgroundColor: 'rgba(110, 160, 255, 0.08)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgba(110, 160, 255, 0.14)' },
      '.cm-selectionMatch': { backgroundColor: 'rgba(255, 196, 0, 0.25)' },
      '&.cm-focused': { outline: 'none' }
    },
    { dark: true }
  );

  function themeExtensions(theme: 'light' | 'dark'): Extension {
    return theme === 'dark' ? [oneDark, darkAccent] : [lightTheme];
  }

  function buildExtensions(): Extension[] {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      highlightSpecialChars(),
      drawSelection(),
      rectangularSelection(),
      crosshairCursor(),
      historyCompartment.of(history()),
      indentUnit.of('  '),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      foldGutter(),
      search({ top: true }),
      highlightSelectionMatches(),
      latex(),
      syntaxHighlighting(latexHighlightStyle, { fallback: true }),
      autocompletion({ override: [latexCompletions] }),
      EditorView.lineWrapping,
      keymap.of([
        ...closeBracketsKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
        ...defaultKeymap
      ]),
      themeCompartment.of(themeExtensions(ui.theme)),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || applyingExternal) return;
        const next = update.state.doc.toString();
        doc.source = next;
        doc.dirty = true;
      })
    ];
  }

  onMount(() => {
    const state = EditorState.create({ doc: doc.source, extensions: buildExtensions() });
    view = new EditorView({ state, parent: hostEl });
  });

  onDestroy(() => {
    view?.destroy();
    view = undefined;
  });

  // Push external changes to doc.source (file open, revert, etc.) into the editor,
  // but only when the content actually differs, to avoid clobbering cursor/selection
  // on every keystroke and to avoid an update <-> effect feedback loop.
  $effect(() => {
    const source = doc.source;
    if (!view) return;
    const current = view.state.doc.toString();
    if (source === current) return;
    applyingExternal = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: source } });
    // Reconfiguring the compartment discards the history state field and starts
    // a fresh one. Without this, undo would walk back into the *previous*
    // document — and since doc.path now points at the newly opened file, the
    // next save would write that stale text over it.
    view.dispatch({ effects: historyCompartment.reconfigure([]) });
    view.dispatch({ effects: historyCompartment.reconfigure(history()) });
    applyingExternal = false;
  });

  // React to theme changes by reconfiguring the theme compartment in place.
  $effect(() => {
    const theme = ui.theme;
    view?.dispatch({ effects: themeCompartment.reconfigure(themeExtensions(theme)) });
  });
</script>

<div class="flex h-full min-h-0 w-full flex-col overflow-hidden bg-surface text-fg">
  <div bind:this={hostEl} class="min-h-0 flex-1 overflow-hidden"></div>
</div>
