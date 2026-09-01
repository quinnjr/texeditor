// Typed wrappers around the Rust command surface.
// OWNER: rust agent.
import { invoke } from '@tauri-apps/api/core';

export type CompileResult = {
  ok: boolean;
  pdfBase64: string | null;
  log: string;
};

/**
 * Engines the Rust `compile_latex` command accepts. Must stay in sync with
 * `KNOWN_ENGINES` in src-tauri/src/lib.rs — `check_engines()` only ever returns
 * values drawn from that same list.
 */
export type LatexEngine = 'pdflatex' | 'xelatex' | 'lualatex';

const ENGINES: readonly LatexEngine[] = ['pdflatex', 'xelatex', 'lualatex'];

/** Narrow an arbitrary string to a LatexEngine, or null if it isn't one. */
export function asEngine(value: string): LatexEngine | null {
  return (ENGINES as readonly string[]).includes(value) ? (value as LatexEngine) : null;
}

/** True when running inside the Tauri desktop shell (vs. a plain browser tab). */
export function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Thrown by the file APIs when they are called outside the desktop shell.
 *
 * These used to resolve to `null` there, which is indistinguishable from "the
 * user cancelled the dialog" — so Open/Save became silent no-ops in `pnpm dev`
 * and a failed save left `doc.dirty` set with no explanation. Callers catch this
 * and surface `message` in the status bar.
 */
export class DesktopOnlyError extends Error {
  constructor(action: string) {
    super(`${action} requires the desktop app`);
    this.name = 'DesktopOnlyError';
  }
}

/** Log marker for "we never got as far as running an engine". */
export const NO_ENGINE_LOG = 'LaTeX compilation requires the desktop app.';

/**
 * True when `log` shows the engine never actually started, as opposed to
 * starting and reporting TeX errors. Keeps the UI from blaming a LaTeX engine
 * that was never invoked.
 */
export function engineNeverRan(log: string): boolean {
  return log.includes(NO_ENGINE_LOG) || /failed to start `/.test(log) || /^unsupported engine: /.test(log);
}

export async function compileLatex(
  source: string,
  engine: LatexEngine
): Promise<CompileResult> {
  if (!hasTauriRuntime()) {
    return {
      ok: false,
      pdfBase64: null,
      log: NO_ENGINE_LOG,
    };
  }
  return await invoke<CompileResult>('compile_latex', { source, engine });
}

/** Resolves to null only when the *user cancelled* the picker. */
export async function openFileDialog(): Promise<{ path: string; content: string } | null> {
  if (!hasTauriRuntime()) {
    throw new DesktopOnlyError('Opening files');
  }
  return await invoke<{ path: string; content: string } | null>('open_file');
}

/** Resolves to null only when the *user cancelled* the save picker. */
export async function saveFile(path: string | null, content: string): Promise<string | null> {
  if (!hasTauriRuntime()) {
    throw new DesktopOnlyError('Saving files');
  }
  return await invoke<string | null>('save_file', { path, content });
}

export async function checkEngines(): Promise<string[]> {
  if (!hasTauriRuntime()) {
    return [];
  }
  return await invoke<string[]>('check_engines');
}

