// Canvas-based PDF rendering for the preview panel.
//
// Why not just `<iframe src="blob:...pdf">`? Because the app ships on
// webkit2gtk, and WebKitGTK has no built-in PDF viewer — an iframe pointed at a
// PDF renders blank (or fires a download signal Tauri then ignores). Chromium
// and Firefox hide this by embedding their own viewer; WebKit does not. So we
// rasterise the pages ourselves with pdf.js, which behaves identically on every
// platform.

import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

type PdfjsModule = typeof import('pdfjs-dist');

// pdfjs-dist is ~450 KB of parsed JS, and most sessions never leave the live
// HTML preview — so it must not be in the boot bundle. Only the *types* are
// imported statically (erased at compile time); the module itself is pulled in
// by `loadPdfjs()` on the first render, which Vite emits as its own chunk.
// `workerUrl` is a `?url` import: it resolves to a plain string and emits the
// worker as an asset, so it costs nothing at boot.
let pdfjsPromise: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    const pending = import('pdfjs-dist').then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = workerUrl;
      return mod;
    });
    // Don't cache a rejection forever: a chunk that failed to load (offline,
    // transient 404) should be retried on the next compile rather than
    // poisoning PDF mode for the rest of the session.
    pending.catch(() => {
      if (pdfjsPromise === pending) pdfjsPromise = null;
    });
    pdfjsPromise = pending;
  }
  return pdfjsPromise;
}

// Mirrored out of node_modules into public/pdfjs by the `pdfjs-vendor-assets`
// plugin in vite.config.ts. Trailing slashes are required by pdf.js.
//
// All four are needed: CMaps decode CJK/encoded text, standard_fonts supplies
// the base-14 font programs, wasm/ holds the JBIG2 + JPEG2000 image decoders
// and the QCMS colour engine, and iccs/ holds the predefined ICC profile pdf.js
// falls back on. Leaving wasm/icc unset makes documents that need them fail to
// render (or silently drop images) instead of falling back cleanly.
const CMAP_URL = '/pdfjs/cmaps/';
const STANDARD_FONT_URL = '/pdfjs/standard_fonts/';
const WASM_URL = '/pdfjs/wasm/';
const ICC_URL = '/pdfjs/iccs/';

/** Cap the backing-store multiplier: past 2x the memory cost buys nothing. */
const MAX_DPR = 2;

export interface DrawOptions {
  /** Width in CSS pixels a page may occupy, before the zoom multiplier. */
  availableWidth: number;
  /** Zoom multiplier on top of fit-to-width. 1 = exactly fit width. */
  zoom: number;
}

export interface PdfHandle {
  readonly pageCount: number;
  /**
   * Width in PDF points of page 1 at scale 1 — i.e. the document's natural
   * width. The UI needs it to turn the fit-to-width multiplier back into a
   * true "% of actual size" the user can reason about.
   */
  readonly naturalWidth: number;
  /** (Re)rasterise every page into the container. Safe to call concurrently. */
  draw(options: DrawOptions): Promise<void>;
  /** Cancel in-flight work, empty the container and release the document. */
  destroy(): Promise<void>;
}

/** Scale pdf.js will actually use for a page of width `naturalWidth`. */
export function effectiveScale(
  naturalWidth: number,
  availableWidth: number,
  zoom: number
): number {
  const fit = availableWidth > 0 && naturalWidth > 0 ? availableWidth / naturalWidth : 1;
  return Math.max(0.1, fit * zoom);
}

/**
 * Load `url` (typically a blob: URL holding freshly compiled output) and return
 * a handle that rasterises it into `container`.
 */
export async function loadPdf(url: string, container: HTMLElement): Promise<PdfHandle> {
  const pdfjs = await loadPdfjs();

  const loadingTask = pdfjs.getDocument({
    url,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_URL,
    wasmUrl: WASM_URL,
    iccUrl: ICC_URL
  });

  let pdf: PDFDocumentProxy;
  let naturalWidth: number;
  try {
    pdf = await loadingTask.promise;
    const first = await pdf.getPage(1);
    naturalWidth = first.getViewport({ scale: 1 }).width;
    first.cleanup();
  } catch (err) {
    // getDocument() has already spawned a worker by the time the promise
    // settles, and a rejection does *not* reap it — without this every failed
    // load (corrupt output, password-protected file, aborted fetch) leaks a
    // Worker plus its transport for the life of the window.
    try {
      await loadingTask.destroy();
    } catch {
      // Worker never came up, or is already gone.
    }
    throw err;
  }

  let generation = 0;
  let inFlight: RenderTask[] = [];
  let destroyed = false;

  function isCancellation(err: unknown): boolean {
    return (
      err instanceof pdfjs.RenderingCancelledException ||
      (err instanceof Error && err.name === 'RenderingCancelledException')
    );
  }

  function cancelInFlight() {
    for (const task of inFlight) {
      try {
        task.cancel();
      } catch {
        // Already settled — nothing to cancel.
      }
    }
    inFlight = [];
  }

  async function draw(options: DrawOptions): Promise<void> {
    if (destroyed) return;

    // Every call invalidates the previous one; `generation` is the guard every
    // await point below re-checks, so a burst of resize/zoom events can never
    // interleave two passes into the same container.
    const gen = ++generation;
    cancelInFlight();

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

    // Lay out empty canvases first so the scroll height is right immediately
    // and the container doesn't collapse while pages rasterise.
    const canvases: HTMLCanvasElement[] = [];
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < pdf.numPages; i++) {
      const canvas = document.createElement('canvas');
      canvas.className = 'tex-pdf-page';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Page ${i + 1} of ${pdf.numPages}`);
      canvases.push(canvas);
      fragment.appendChild(canvas);
    }
    if (gen !== generation || destroyed) return;
    container.replaceChildren(fragment);

    for (let i = 0; i < canvases.length; i++) {
      if (gen !== generation || destroyed) return;

      const page = await pdf.getPage(i + 1);
      if (gen !== generation || destroyed) {
        page.cleanup();
        return;
      }

      const unscaled = page.getViewport({ scale: 1 });
      const scale = effectiveScale(unscaled.width, options.availableWidth, options.zoom);
      const viewport = page.getViewport({ scale });

      const canvas = canvases[i];
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const task = page.render({
        canvas,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0]
      });
      inFlight.push(task);

      try {
        await task.promise;
      } catch (err) {
        // A cancellation just means a newer draw() superseded us; anything else
        // is a genuine failure the caller should surface.
        if (isCancellation(err)) return;
        throw err;
      } finally {
        inFlight = inFlight.filter((t) => t !== task);
        page.cleanup();
      }
    }
  }

  async function destroy(): Promise<void> {
    if (destroyed) return;
    destroyed = true;
    generation++;
    cancelInFlight();
    container.replaceChildren();
    try {
      // Tearing down the loading task is what releases the document and its
      // worker; PDFDocumentProxy itself has no destroy() in pdf.js v6.
      await loadingTask.destroy();
    } catch {
      // Worker already gone.
    }
  }

  return {
    get pageCount() {
      return pdf.numPages;
    },
    get naturalWidth() {
      return naturalWidth;
    },
    draw,
    destroy
  };
}
