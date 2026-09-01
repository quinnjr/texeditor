import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));

/**
 * pdf.js fetches its CMap tables and the base-14 standard font programs over
 * HTTP at render time instead of importing them, so Vite's module graph never
 * sees them and they would 404 in the packaged app. Mirror them into `public/`
 * (gitignored) — Vite then serves them in dev and copies them into `dist/` on
 * build, with no extra middleware. `src/lib/preview/pdf.ts` points pdf.js at
 * the resulting `/pdfjs/**` URLs.
 */
function pdfjsAssets(): Plugin {
  return {
    name: 'pdfjs-vendor-assets',
    buildStart() {
      const version: string = JSON.parse(
        fs.readFileSync(path.join(pdfjsRoot, 'package.json'), 'utf8')
      ).version;
      const outRoot = path.join(projectRoot, 'public', 'pdfjs');
      const stamp = path.join(outRoot, '.version');

      // Re-copy only when the installed pdfjs-dist version changes, so an
      // upgrade can't leave stale CMaps behind while a normal build stays fast.
      if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === version) return;

      fs.rmSync(outRoot, { recursive: true, force: true });
      fs.mkdirSync(outRoot, { recursive: true });
      for (const dir of ['cmaps', 'standard_fonts']) {
        const from = path.join(pdfjsRoot, dir);
        if (!fs.existsSync(from)) continue;
        fs.cpSync(from, path.join(outRoot, dir), { recursive: true });
      }
      fs.writeFileSync(stamp, version);
    }
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [pdfjsAssets(), svelte(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'esnext',
    sourcemap: false,
    emptyOutDir: true
  }
});
