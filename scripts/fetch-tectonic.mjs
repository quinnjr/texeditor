#!/usr/bin/env node
// Fetch the Tectonic binary for one or more target triples into
// src-tauri/binaries/, named the way Tauri's `externalBin` expects
// (`tectonic-<target-triple>` plus `.exe` on Windows).
//
// Tectonic is bundled so a fresh install can typeset a PDF without the user
// first installing a multi-gigabyte TeX distribution. Upstream publishes
// prebuilt binaries; every one we ship is pinned to a SHA-256 recorded in
// tectonic.lock.json, and a mismatch aborts the build rather than shipping an
// unverified compiler to users.
//
//   node scripts/fetch-tectonic.mjs              # host triple only
//   node scripts/fetch-tectonic.mjs --all        # every supported triple
//   node scripts/fetch-tectonic.mjs --target x86_64-apple-darwin

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src-tauri', 'binaries');
const LOCK = JSON.parse(readFileSync(join(ROOT, 'scripts', 'tectonic.lock.json'), 'utf8'));

/** Rust target triple of the machine we are running on. */
function hostTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('host:'));
  if (!line) throw new Error('could not read host triple from `rustc -vV`');
  return line.slice('host:'.length).trim();
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Pull the `tectonic` executable out of the release archive. Upstream ships
 * .tar.gz for Unix and .zip for Windows, each with the binary at the root.
 */
function extract(archive, asset, workDir) {
  const archivePath = join(workDir, asset);
  writeFileSync(archivePath, archive);
  if (asset.endsWith('.zip')) {
    execFileSync('unzip', ['-o', '-q', archivePath, '-d', workDir]);
    return join(workDir, 'tectonic.exe');
  }
  execFileSync('tar', ['xzf', archivePath, '-C', workDir]);
  return join(workDir, 'tectonic');
}

async function fetchOne(triple) {
  const entry = LOCK.targets[triple];
  if (!entry) {
    throw new Error(
      `no pinned Tectonic build for ${triple}. Supported: ${Object.keys(LOCK.targets).join(', ')}`
    );
  }

  const suffix = triple.includes('windows') ? '.exe' : '';
  const dest = join(OUT_DIR, `${LOCK.binaryName}-${triple}${suffix}`);
  if (existsSync(dest) && !process.argv.includes('--force')) {
    console.log(`· ${triple} already present`);
    return dest;
  }

  const url = `${LOCK.baseUrl}/tectonic%40${LOCK.version}/${entry.asset}`;
  console.log(`↓ ${triple} <- ${entry.asset}`);
  const archive = await download(url);

  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== entry.sha256) {
    throw new Error(
      `checksum mismatch for ${entry.asset}\n  expected ${entry.sha256}\n  got      ${digest}\n` +
        'Refusing to bundle an unverified LaTeX engine.'
    );
  }

  const workDir = join(tmpdir(), `tectonic-fetch-${process.pid}-${triple}`);
  mkdirSync(workDir, { recursive: true });
  try {
    const binary = extract(archive, entry.asset, workDir);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(dest, readFileSync(binary));
    if (!suffix) chmodSync(dest, 0o755);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log(`✓ ${dest}`);
  return dest;
}

const args = process.argv.slice(2);
const explicit = args.filter((a, i) => args[i - 1] === '--target');
const triples = args.includes('--all')
  ? Object.keys(LOCK.targets)
  : explicit.length > 0
    ? explicit
    : [hostTriple()];

let failed = false;
for (const t of triples) {
  try {
    await fetchOne(t);
  } catch (err) {
    failed = true;
    console.error(`✗ ${t}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
