<!--
  Live/PDF preview mode toggle. OWNER: shell agent.

  Previously duplicated in Toolbar.svelte and App.svelte's preview pane
  header, and the two copies had already drifted: App's hardcoded "Ctrl+\\"
  in its tooltip even on Mac, while Toolbar computed the ⌘ glyph. One
  component, one mod-key computation, so there is nothing left to drift.

  The active mode is marked with a rule underneath rather than a pill: the
  same gesture a proofreader uses to mark a word, and quiet enough to sit
  in a panel header without competing with the page beside it.
-->
<script lang="ts">
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);
  const mod = isMac ? '⌘' : 'Ctrl';

  let {
    mode,
    setMode,
    size = 'md',
    wrapperClass = ''
  }: {
    mode: 'live' | 'pdf';
    setMode: (mode: 'live' | 'pdf') => void;
    /** 'md' fits a full-height toolbar; 'sm' fits a tighter panel header bar. */
    size?: 'md' | 'sm';
    /** Extra classes for the toggle's own background/spacing in its context. */
    wrapperClass?: string;
  } = $props();

  const pad = $derived(size === 'sm' ? 'px-1.5 pb-1 pt-1.5' : 'px-2 pb-1.5 pt-2');
</script>

<div class="mark flex items-center gap-3 {wrapperClass}">
  <button
    type="button"
    class="relative {pad} transition-colors {mode === 'live'
      ? 'text-fg'
      : 'text-fg-muted hover:text-fg'}"
    onclick={() => setMode('live')}
    aria-pressed={mode === 'live'}
    title="Live preview ({mod}+\\)"
  >
    Live
    <span
      class="pointer-events-none absolute inset-x-0 bottom-0 h-px transition-colors {mode === 'live'
        ? 'bg-accent'
        : 'bg-transparent'}"
    ></span>
  </button>
  <button
    type="button"
    class="relative {pad} transition-colors {mode === 'pdf'
      ? 'text-fg'
      : 'text-fg-muted hover:text-fg'}"
    onclick={() => setMode('pdf')}
    aria-pressed={mode === 'pdf'}
    title="Compiled PDF ({mod}+\\)"
  >
    PDF
    <span
      class="pointer-events-none absolute inset-x-0 bottom-0 h-px transition-colors {mode === 'pdf'
        ? 'bg-accent'
        : 'bg-transparent'}"
    ></span>
  </button>
</div>
