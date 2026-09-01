<!--
  Live/PDF preview mode toggle. OWNER: shell agent.

  Previously duplicated in Toolbar.svelte and App.svelte's preview pane
  header, and the two copies had already drifted: App's hardcoded "Ctrl+\\"
  in its tooltip even on Mac, while Toolbar computed the ⌘ glyph. One
  component, one mod-key computation, so there is nothing left to drift.
-->
<script lang="ts">
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);
  const mod = isMac ? '⌘' : 'Ctrl';

  let {
    mode,
    setMode,
    size = 'md',
    wrapperClass = 'bg-surface-alt'
  }: {
    mode: 'live' | 'pdf';
    setMode: (mode: 'live' | 'pdf') => void;
    /** 'md' fits a full-height toolbar; 'sm' fits a tighter panel header bar. */
    size?: 'md' | 'sm';
    /** Extra classes for the toggle's own background/spacing in its context. */
    wrapperClass?: string;
  } = $props();

  const buttonPad = $derived(size === 'sm' ? 'px-2 py-0.5' : 'px-2 py-1');
  const textSize = $derived(size === 'sm' ? 'text-[11px]' : 'text-xs');
</script>

<div class="flex items-center gap-0.5 rounded-md p-0.5 {textSize} {wrapperClass}">
  <button
    type="button"
    class="rounded {buttonPad} transition-colors {mode === 'live'
      ? 'bg-surface text-fg shadow-sm'
      : 'text-fg-muted hover:text-fg'}"
    onclick={() => setMode('live')}
    aria-pressed={mode === 'live'}
    title="Live preview ({mod}+\\)"
  >
    Live
  </button>
  <button
    type="button"
    class="rounded {buttonPad} transition-colors {mode === 'pdf'
      ? 'bg-surface text-fg shadow-sm'
      : 'text-fg-muted hover:text-fg'}"
    onclick={() => setMode('pdf')}
    aria-pressed={mode === 'pdf'}
    title="Compiled PDF ({mod}+\\)"
  >
    PDF
  </button>
</div>
