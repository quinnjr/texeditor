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
    toggleTheme: () => void;
  } = $props();

  const filename = $derived(doc.path ? doc.path.split(/[\\/]/).pop() ?? doc.path : 'untitled.tex');
  const saveDisabled = $derived(!fileAccess || (!doc.dirty && doc.path !== null));
  const compileDisabled = $derived(build.compiling || engines.length === 0);
  const fileHint = 'File access requires the desktop app';
</script>

<header class="flex h-11 shrink-0 items-center gap-1 border-b border-edge bg-surface pr-3 pl-4">
  <!-- The wordmark is set the way TeX sets its own name: Latin Modern, with
       the E dropped and kerned in. It is the most characteristic artifact of
       this program's subject, so it does the identity work and nothing else
       in the chrome has to. -->
  <span class="select-none font-serif text-[15px] leading-none text-fg" title="TeX Viewer">
    T<span class="relative top-[0.22em] -mx-[0.09em] inline-block">e</span>X<span
      class="ml-1.5 text-fg-muted">Viewer</span
    >
  </span>

  <div class="mx-3 h-4 w-px bg-edge"></div>

  <button
    type="button"
    class="mark rounded-sm px-2 py-1.5 text-fg-muted transition-colors hover:bg-accent-soft hover:text-fg disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
    onclick={onOpen}
    disabled={!fileAccess}
    title={fileAccess ? `Open… (${mod}+O)` : fileHint}
  >
    Open
  </button>

  <button
    type="button"
    class="mark rounded-sm px-2 py-1.5 text-fg-muted transition-colors hover:bg-accent-soft hover:text-fg disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
    onclick={onSave}
    disabled={saveDisabled}
    title={fileAccess ? `Save (${mod}+S)` : fileHint}
  >
    Save
  </button>

  <div class="mx-3 h-4 w-px bg-edge"></div>

  <select
    class="mark cursor-pointer rounded-sm border border-edge bg-transparent px-2 py-1 text-fg-muted transition-colors hover:border-edge-strong hover:text-fg disabled:cursor-not-allowed disabled:opacity-35"
    value={engine}
    disabled={engines.length === 0}
    onchange={(e) => onEngineChange((e.currentTarget as HTMLSelectElement).value)}
    title="LaTeX engine"
  >
    {#if engines.length === 0}
      <option value="">No engine</option>
    {:else}
      {#each engines as e (e)}
        <option value={e}>{e}</option>
      {/each}
    {/if}
  </select>

  <button
    type="button"
    class="mark ml-1 flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-accent-fg transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30"
    onclick={onCompile}
    disabled={compileDisabled}
    title="Compile ({mod}+B)"
  >
    {#if build.compiling}
      <svg class="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle class="opacity-30" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4Z"></path>
      </svg>
      Compiling
    {:else}
      Compile
    {/if}
  </button>

  <div class="mx-3 h-4 w-px bg-edge"></div>

  <button
    type="button"
    class="rounded-sm p-1.5 text-fg-muted transition-colors hover:bg-accent-soft hover:text-fg"
    onclick={toggleTheme}
    title="Toggle theme ({mod}+Shift+D)"
    aria-label="Toggle theme"
  >
    {#if ui.theme === 'dark'}
      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    {:else}
      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M20.354 15.354A9 9 0 0 1 8.646 3.646 9.003 9.003 0 1 0 20.354 15.354Z" />
      </svg>
    {/if}
  </button>

  <div class="mark ml-auto flex items-center gap-2 text-fg-muted">
    <span class="max-w-[16rem] truncate normal-case tracking-normal">{filename}</span>
    {#if doc.dirty}
      <span class="h-1 w-1 shrink-0 rounded-full bg-accent" title="Unsaved changes"></span>
    {/if}
  </div>
</header>
