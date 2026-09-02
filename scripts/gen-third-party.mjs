#!/usr/bin/env node
// Regenerate THIRD-PARTY-LICENSES.md from what is actually in the dependency
// graph, so the notice we ship cannot drift from the code we ship.
//
// Sources:
//   · pnpm licenses list --prod   — runtime npm packages
//   · cargo metadata              — Rust crates linked into the binary
//   · a hand-kept table for the things no package manager knows about: the
//     bundled Tectonic engine and the Latin Modern fonts vendored in src/fonts.
//
//   node scripts/gen-third-party.mjs

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// pnpm on Windows is a .cmd/.ps1 shim. Since Node 18.20.2 / 20.12.2
// (CVE-2024-27980) spawnSync refuses to execute .bat/.cmd at all unless
// `shell: true`, so naming `pnpm.cmd` only trades ENOENT for EINVAL - the
// guard lives in the spawn layer, not the resolver. The arguments here are
// fixed literals with no spaces or shell metacharacters, so routing them
// through cmd.exe is safe; do not extend this helper with interpolated input.
const WINDOWS = process.platform === 'win32';

function sh(cmd, args, cwd = ROOT) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: WINDOWS
  });
}

/** Runtime npm dependencies, deduped by name. */
function npmPackages() {
  const raw = JSON.parse(sh('pnpm', ['licenses', 'list', '--json', '--prod']));
  // pnpm reports failures as {"error": {...}} on stdout *with exit code 0*, so
  // iterating the buckets blind throws "pkgs is not iterable" instead of
  // saying what went wrong.
  if (raw && typeof raw === 'object' && raw.error) {
    throw new Error(
      `pnpm licenses failed: ${raw.error.code ?? 'unknown'} - ${raw.error.message ?? ''}`
    );
  }
  const out = new Map();
  for (const [license, pkgs] of Object.entries(raw)) {
    for (const p of pkgs) {
      out.set(p.name, {
        name: p.name,
        version: Array.isArray(p.versions) ? p.versions.join(', ') : (p.version ?? ''),
        license,
        url: p.homepage ?? ''
      });
    }
  }
  const resolved = [...out.values()].sort((a, b) => a.name.localeCompare(b.name));

  // Two ways to end up writing a worthless notice, both at exit code 0:
  //
  //   · no installed node_modules - every package comes back "Unknown"
  //   · a lockfile that resolves no prod importers - the result is `{}`
  //
  // Either would silently drop every real licence from the file. Refuse both.
  // Deliberately NOT "any package is Unknown": a single dependency whose
  // package.json omits `license` is normal, and failing on it would block
  // every release with no way to proceed. It still shows up in the notice as
  // Unknown, which is the honest rendering.
  if (resolved.length === 0) {
    throw new Error(
      'pnpm resolved no production packages. Run `pnpm install` first - the notice was NOT rewritten.'
    );
  }
  const unknown = resolved.filter((p) => /^unknown$/i.test(p.license));
  if (unknown.length === resolved.length) {
    throw new Error(
      `pnpm reported no licence for any of the ${resolved.length} packages, which means ` +
        'they are unresolved rather than genuinely unlicensed. Run `pnpm install` first - ' +
        'the notice was NOT rewritten.'
    );
  }
  return resolved;
}

/**
 * Rust crates. `cargo metadata` lists the whole workspace graph including dev
 * and build-only crates; we keep the resolved set, which is what actually gets
 * compiled in, and drop our own crate.
 */
function cargoCrates() {
  const meta = JSON.parse(
    sh('cargo', ['metadata', '--format-version', '1', '--all-features'], join(ROOT, 'src-tauri'))
  );
  const workspace = new Set(meta.workspace_members);
  return meta.packages
    .filter((p) => !workspace.has(p.id))
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? p.license_file ?? 'see repository',
      url: p.repository ?? p.homepage ?? ''
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Things shipped in the installer that no manifest covers. */
const BUNDLED = [
  {
    name: 'Tectonic',
    version: '0.17.0',
    license: 'MIT',
    url: 'https://tectonic-typesetting.github.io/',
    note: 'LaTeX engine shipped as a sidecar binary. Full text: LICENSES/tectonic.LICENSE. Tectonic incorporates TeX, XeTeX and TeX Live components under their own permissive licences, enumerated in that file.'
  },
  {
    name: 'Latin Modern',
    version: '2.004',
    license: 'GUST Font License (GFL)',
    url: 'https://www.gust.org.pl/projects/e-foundry/latin-modern',
    note: 'Five faces subset to Latin-1 and vendored in src/fonts/. (c) 2003-2009 B. Jackowski and J.M. Nowacki. Full text: LICENSES/latin-modern.GUST-FONT-LICENSE.txt. The GFL requires the licence to travel with the fonts, which is why it is installed alongside the application.'
  }
];

function table(rows) {
  const head = '| Package | Version | License |\n| --- | --- | --- |';
  const body = rows
    .map((r) => {
      const name = r.url ? `[${r.name}](${r.url})` : r.name;
      return `| ${name} | ${r.version} | ${r.license} |`;
    })
    .join('\n');
  return `${head}\n${body}`;
}

const npm = npmPackages();
const crates = cargoCrates();

const doc = `# Third-party licenses

TeX Viewer is licensed under Apache-2.0 (see \`LICENSE\`). It ships and links the
third-party work listed here. This file is generated — run
\`node scripts/gen-third-party.mjs\` to refresh it; do not edit it by hand.

Full licence texts for the components we redistribute as binaries or font files
live in \`LICENSES/\` and are installed alongside the application.

## Bundled components

${BUNDLED.map(
  (b) =>
    `### ${b.name} ${b.version} — ${b.license}\n\n${b.note}\n\nHome: <${b.url}>`
).join('\n\n')}

## Rust crates (${crates.length})

Linked into the application binary.

${table(crates)}

## npm packages (${npm.length})

Bundled into the application's frontend.

${table(npm)}
`;

writeFileSync(join(ROOT, 'THIRD-PARTY-LICENSES.md'), doc);
console.log(
  `THIRD-PARTY-LICENSES.md: ${BUNDLED.length} bundled, ${crates.length} crates, ${npm.length} npm packages`
);
