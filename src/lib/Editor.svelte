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
  import { doc, ui } from './stores.svelte';
  import { latex, latexHighlightStyle } from './editor/latex-language';
  import { latexCompletions } from './editor/latex-completions';

  let hostEl: HTMLDivElement;
  let view: EditorView | undefined;

  /** Swaps the editor theme without rebuilding the editor. */
  const themeCompartment = new Compartment();

  /** Holds the undo history so it can be thrown away when a different document is loaded. */
  const historyCompartment = new Compartment();

  /** True while an *external* doc.source change is being pushed into CodeMirror, so the
   *  update listener below does not mistake it for a user edit and mark the doc dirty. */
  let applyingExternal = false;

  /* One theme for both schemes. Every colour resolves to an app token that
     `.dark` already swaps in app.css, so the editor cannot drift out of step
     with the rest of the chrome and there is only one palette to maintain.
     The markup is annotation, not document, so it is set in the chrome's
     non-repro blue family with a single warm ochre for maths. */
  const appTheme = EditorView.theme({
    '&': {
      height: '100%',
      backgroundColor: 'var(--app-surface)',
      color: 'var(--app-fg)'
    },
    '.cm-content': { caretColor: 'var(--app-accent)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--app-accent)' },
    '.cm-scroller': {
      fontFamily: 'var(--app-font-ui)',
      fontSize: '12.5px',
      lineHeight: '1.65'
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--app-fg-muted)',
      border: 'none',
      paddingRight: '0.35rem',
      opacity: '0.55'
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.5rem 0 1rem' },
    '.cm-activeLine': { backgroundColor: 'var(--app-accent-soft)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', opacity: '1' },
    '.cm-selectionMatch': { backgroundColor: 'var(--app-accent-soft)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'transparent',
      outline: '1px solid var(--app-border-strong)'
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'transparent',
      border: '1px solid var(--app-border-strong)',
      borderRadius: '2px',
      color: 'var(--app-fg-muted)',
      padding: '0 0.35em',
      margin: '0 0.2em'
    },
    '.cm-panels': {
      backgroundColor: 'var(--app-surface-alt)',
      color: 'var(--app-fg)',
      border: 'none',
      borderTop: '1px solid var(--app-border)'
    },
    '.cm-panel input, .cm-panel button': {
      fontFamily: 'var(--app-font-ui)',
      fontSize: '11px'
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--app-surface-alt)',
      border: '1px solid var(--app-border)',
      borderRadius: '2px'
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--app-accent-soft)',
      color: 'var(--app-fg)'
    },
    '&.cm-focused': { outline: 'none' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'var(--app-accent-soft)'
    }
  });

  function themeExtensions(theme: 'light' | 'dark'): Extension {
    // `dark` only tells CodeMirror which built-in defaults to assume; the
    // colours themselves come from the tokens above either way.
    return [appTheme, EditorView.darkTheme.of(theme === 'dark')];
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
