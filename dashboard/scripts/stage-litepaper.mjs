#!/usr/bin/env node
/** Stage only the reviewed, static litepaper files into Next's public tree. */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APPROVED_SOURCE_SHA256 = '11313c967764fac0691f08ac9670db2b40543f8f2395d5ac876d4dcf4d091310';
export const LITEPAPER_FILES = Object.freeze([
  'LITEPAPER.md', 'TOKENOMICS.md', 'THOUGHTS.md', 'WHITEPAPER.md',
  'docs/litepaper/index.html',
  'docs/litepaper/litepaper.css',
  'docs/litepaper/litepaper.js',
  'docs/litepaper/experience-motion.js',
  'docs/litepaper/assets/agent-computer-hero-v2.png',
  'docs/litepaper/assets/agent-computer-opportunity-v2.png',
  'docs/litepaper/assets/observable-run-v2.png',
  'docs/litepaper/assets/boundary-monolith-v5.png',
  'docs/litepaper/assets/fonts/Manrope-Variable.ttf',
  'docs/litepaper/assets/fonts/Manrope-OFL.txt',
  'docs/litepaper/assets/fonts/IBMPlexMono-Regular.ttf',
  'docs/litepaper/assets/fonts/IBMPlexMono-OFL.txt',
  'docs/litepaper/vendor/gsap-3.15.0.min.js',
  'docs/litepaper/vendor/ScrollTrigger-3.15.0.min.js',
  'docs/litepaper/vendor/NOTICE.md',
]);

function rejectSymlinks(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink is not a litepaper artifact: ${relative}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function existingFiles(root, directory) {
  if (!existsSync(path.join(root, directory))) return [];
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    rejectSymlinks(root, relative);
    return entry.isDirectory() ? existingFiles(root, relative) : [relative];
  });
}

export function stageLitepaper({ repoRoot, dashboardRoot = path.join(repoRoot, 'dashboard'), check = false, approvedSha256 = APPROVED_SOURCE_SHA256 }) {
  repoRoot = realpathSync(repoRoot);
  dashboardRoot = realpathSync(dashboardRoot);
  const publicRoot = path.join(dashboardRoot, 'public');
  rejectSymlinks(dashboardRoot, 'public');
  rejectSymlinks(repoRoot, 'LITEPAPER.md');
  const litepaperHash = createHash('sha256').update(readFileSync(path.join(repoRoot, 'LITEPAPER.md'))).digest('hex');
  if (litepaperHash !== approvedSha256) {
    throw new Error('LITEPAPER.md differs from the current user-approved source.');
  }

  // Complete validation before writing: an absent asset must not leave a partial package.
  const files = LITEPAPER_FILES.map((relative) => {
    rejectSymlinks(repoRoot, relative);
    rejectSymlinks(publicRoot, relative);
    const source = path.join(repoRoot, relative);
    if (!lstatSync(source).isFile()) throw new Error(`Not a regular litepaper file: ${relative}`);
    return { relative, source, target: path.join(publicRoot, relative), bytes: readFileSync(source) };
  });
  const unexpected = existingFiles(publicRoot, 'docs/litepaper').filter((relative) => !LITEPAPER_FILES.includes(relative));
  if (unexpected.length) throw new Error(`Unexpected file in the generated litepaper directory: ${unexpected.join(', ')}`);
  const stale = files.filter(({ target, bytes }) => !existsSync(target) || !readFileSync(target).equals(bytes));
  if (check && stale.length) throw new Error(`Litepaper staging is stale: ${stale.map(({ relative }) => relative).join(', ')}`);
  if (!check) {
    for (const { source, target } of stale) {
      mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.tmp`;
      try {
        copyFileSync(source, temporary);
        renameSync(temporary, target);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
  }
  return { files: files.length, updated: check ? 0 : stale.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((argument) => argument !== '--check')) throw new Error('Usage: node scripts/stage-litepaper.mjs [--check]');
    const dashboardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const result = stageLitepaper({ repoRoot: path.dirname(dashboardRoot), dashboardRoot, check: process.argv.includes('--check') });
    console.log(`Litepaper: ${result.files} allowlisted files verified; ${result.updated} updated.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
