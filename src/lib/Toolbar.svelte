<!-- Top toolbar. OWNER: shell agent. -->
<script lang="ts">
  import { doc, ui, build } from './stores.svelte';

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);
  const mod = isMac ? '⌘' : 'Ctrl';

  let {
    engine,
    engines,
    onEngineChange,
    fileAccess,
    onOpen,
    onSave,
    onCompile,
    setMode,
    toggleTheme
  }: {
    engine: string;
    engines: string[];
    onEngineChange: (engine: string) => void;
    /** False in a plain browser tab, where the native file dialogs don't exist. */
    fileAccess: boolean;
    onOpen: () => void;
    onSave: () => void;
    onCompile: () => void;
    setMode: (mode: 'live' | 'pdf') => void;
    toggleTheme: () => void;
  } = $props();

  const filename = $derived(doc.path ? doc.path.split(/[\\/]/).pop() ?? doc.path : 'untitled.tex');
  const saveDisabled = $derived(!fileAccess || (!doc.dirty && doc.path !== null));
  const compileDisabled = $derived(build.compiling || engines.length === 0);
  const fileHint = 'File access requires the desktop app';
</script>

<header class="flex h-11 shrink-0 items-center gap-2 border-b border-edge bg-surface px-3 text-sm">
  <span class="font-semibold tracking-tight">TeX Viewer</span>

  <div class="mx-1 h-5 w-px bg-edge"></div>

  <button
    type="button"
    class="rounded-md px-2.5 py-1 text-fg-muted transition-colors hover:bg-surface-alt hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    onclick={onOpen}
    disabled={!fileAccess}
    title={fileAccess ? `Open… (${mod}+O)` : fileHint}
  >
    Open
  </button>

  <button
    type="button"
    class="rounded-md px-2.5 py-1 text-fg-muted transition-colors hover:bg-surface-alt hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    onclick={onSave}
    disabled={saveDisabled}
    title={fileAccess ? `Save (${mod}+S)` : fileHint}
  >
    Save
  </button>

  <div class="mx-1 h-5 w-px bg-edge"></div>

  <select
    class="rounded-md border border-edge bg-surface px-2 py-1 text-fg disabled:cursor-not-allowed disabled:opacity-40"
    value={engine}
    disabled={engines.length === 0}
    onchange={(e) => onEngineChange((e.currentTarget as HTMLSelectElement).value)}
    title="LaTeX engine"
  >
    {#if engines.length === 0}
      <option value="">No engine found</option>
    {:else}
      {#each engines as e (e)}
        <option value={e}>{e}</option>
      {/each}
    {/if}
  </select>

  <button
    type="button"
    class="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
    onclick={onCompile}
    disabled={compileDisabled}
    title="Compile ({mod}+B)"
  >
    {#if build.compiling}
      <svg class="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle class="opacity-30" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4Z"></path>
      </svg>
      Compiling…
    {:else}
      Compile
    {/if}
  </button>

  <div class="mx-1 h-5 w-px bg-edge"></div>

  <div class="flex items-center gap-0.5 rounded-md bg-surface-alt p-0.5 text-xs">
    <button
      type="button"
      class="rounded px-2 py-1 transition-colors {ui.mode === 'live' ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}"
      onclick={() => setMode('live')}
      aria-pressed={ui.mode === 'live'}
      title="Live preview ({mod}+\\)"
    >
      Live
    </button>
    <button
      type="button"
      class="rounded px-2 py-1 transition-colors {ui.mode === 'pdf' ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}"
      onclick={() => setMode('pdf')}
      aria-pressed={ui.mode === 'pdf'}
      title="Compiled PDF ({mod}+\\)"
    >
      PDF
    </button>
  </div>

  <button
    type="button"
    class="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-surface-alt hover:text-fg"
    onclick={toggleTheme}
    title="Toggle theme ({mod}+Shift+D)"
    aria-label="Toggle theme"
  >
    {#if ui.theme === 'dark'}
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    {:else}
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M20.354 15.354A9 9 0 0 1 8.646 3.646 9.003 9.003 0 1 0 20.354 15.354Z" />
      </svg>
    {/if}
  </button>

  <div class="ml-auto flex items-center gap-1.5 text-fg-muted">
    <span class="max-w-[16rem] truncate">{filename}</span>
    {#if doc.dirty}
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Unsaved changes"></span>
    {/if}
  </div>
</header>
