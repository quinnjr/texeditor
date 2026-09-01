// Typed wrappers around the Rust command surface.
// OWNER: rust agent.
import { invoke } from '@tauri-apps/api/core';

export type CompileResult = {
  ok: boolean;
  log: string;
  /** Raw PDF bytes, or null when the compile produced none. */
  pdfBytes: Uint8Array<ArrayBuffer> | null;
};

/**
 * A LaTeX engine identifier, as returned by `checkEngines()`. There is no
 * fixed union here on purpose: the set of accepted engines is Rust's
 * `KNOWN_ENGINES` (src-tauri/src/lib.rs), and `checkEngines()` is the one
 * place that list crosses into TypeScript. Keeping a second, hand-copied
 * union here is exactly the kind of duplicate the two are guaranteed to
 * drift out of sync with.
 */
export type LatexEngine = string;

/** Narrow an arbitrary string to one of `known` (typically the last `checkEngines()` result), or null. */
export function asEngine(value: string, known: readonly string[]): LatexEngine | null {
  return known.includes(value) ? value : null;
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
 * Every way `compile_latex` (src-tauri/src/lib.rs) can fail *before* an engine
 * process exists. Each entry matches the exact `format!` string the Rust side
 * emits, anchored to the start of a line because the failures are written as
 * their own line into an otherwise empty or pass-prefixed log.
 *
 * Keep this list in sync with lib.rs. Deliberately absent:
 *   - "failed to read main.pdf: …" — the engine ran and exited 0; the log tail
 *     above it is genuine engine output, so this is a distinct failure, not a
 *     "the engine never ran" one.
 *   - "failed to wait on `…`" / "timed out" — the process was spawned.
 */
const PRE_ENGINE_FAILURES: readonly RegExp[] = [
  // Rejected by the KNOWN_ENGINES guard, before any spawn.
  /^unsupported engine: `/m,
  // std::process::Command::spawn() failed — binary missing from PATH, not
  // executable, fork failed.
  /^failed to start `/m,
  // tempfile::tempdir() failed — TMPDIR full, read-only, or missing.
  /^failed to create a temp directory: /m,
  // fs::write of main.tex failed — disk full, quota, permissions.
  /^failed to write main\.tex: /m
];

/**
 * True when `log` shows the engine never actually started, as opposed to
 * starting and reporting TeX errors. Keeps the UI from blaming a LaTeX engine
 * that was never invoked — a full TMPDIR is not a TeX error.
 */
export function engineNeverRan(log: string): boolean {
  return log.includes(NO_ENGINE_LOG) || PRE_ENGINE_FAILURES.some((re) => re.test(log));
}

/**
 * `compile_latex` returns a `tauri::ipc::Response` rather than JSON, so a
 * multi-megabyte PDF doesn't cross the IPC boundary as base64 (encoded on the
 * Rust side, then `atob`'d and copied byte-by-byte on this one) for no
 * benefit over handing over the bytes directly. The wire format is a little
 * hand-rolled frame — see `encode_compile_response` in src-tauri/src/lib.rs,
 * which this must stay in sync with:
 *
 *   [0..4)   u32, little-endian: length of the header in bytes
 *   [4..4+n) UTF-8 JSON: { ok: boolean, log: string }
 *   [4+n..)  raw PDF bytes (possibly empty)
 */
export function decodeCompileResponse(buf: ArrayBuffer): CompileResult {
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 4, headerLen))
  ) as { ok: boolean; log: string };
  const pdfBytes = new Uint8Array(buf, 4 + headerLen);
  return {
    ok: header.ok,
    log: header.log,
    pdfBytes: pdfBytes.byteLength > 0 ? pdfBytes : null
  };
}

export async function compileLatex(
  source: string,
  engine: LatexEngine,
  docPath: string | null
): Promise<CompileResult> {
  if (!hasTauriRuntime()) {
    return {
      ok: false,
      log: NO_ENGINE_LOG,
      pdfBytes: null
    };
  }
  const buf = await invoke<ArrayBuffer>('compile_latex', { source, engine, docPath });
  return decodeCompileResponse(buf);
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
