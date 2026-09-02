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

function sh(cmd, args, cwd = ROOT) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Runtime npm dependencies, deduped by name. */
function npmPackages() {
  const raw = JSON.parse(sh('pnpm', ['licenses', 'list', '--json', '--prod']));
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
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
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
