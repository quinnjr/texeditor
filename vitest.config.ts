import { defineConfig } from 'vitest/config';

/**
 * Tests get their own config rather than borrowing vite.config.ts.
 *
 * vite.config.ts exists to build the app: it resolves pdfjs-dist through
 * `createRequire` at module scope and mirrors its asset directories on
 * buildStart. None of that is wanted for a node-environment unit suite, and
 * pulling it in made the suite fragile — dependency optimization would fail
 * with "Could not resolve 'node:module' in \0rolldown/runtime.js" depending on
 * where the checkout happened to sit on disk, which is exactly the kind of
 * thing a test run should not be sensitive to. (It reproduced whenever the
 * working copy lived inside another checkout, i.e. in .worktrees/.)
 *
 * The renderer under test is plain TypeScript with no Vite-specific behaviour,
 * so it needs nothing from the build config.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    environment: 'node',
    // The renderer imports katex's stylesheet for its side effect; in a node
    // suite it is stubbed rather than processed.
    css: false
  }
});
