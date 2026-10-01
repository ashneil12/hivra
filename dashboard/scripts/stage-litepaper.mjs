#!/usr/bin/env node
/**
 * Stage the reviewed litepaper files.
 *
 * Two places, for two reasons:
 * - dashboard/public/ gets only what has no token text: the stylesheet, script,
 *   images, fonts, THOUGHTS.md and the token-free copies. Next serves these as
 *   static files.
 * - dashboard/.generated/litepaper/ gets the four documents that do carry token
 *   text (LITEPAPER.md, WHITEPAPER.md, TOKENOMICS.md and the litepaper page),
 *   each beside its token-free copy. They are not public files. The route
 *   handlers behind those four addresses choose a copy by the viewer's country
 *   (src/lib/compliance/token-geo-documents.ts), so no spelling of the path can
 *   reach a full document as a static file.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APPROVED_SOURCE_SHA256 = 'e5d9711930c1bbfa60fb75e2a8057a808907df2eb30e881de965c19d3aecb1a6';
export const LITEPAPER_FILES = Object.freeze([
  'THOUGHTS.md',
  'docs/litepaper/restricted.html',
  'docs/litepaper/litepaper.css',
  'docs/litepaper/litepaper.js',
  'docs/litepaper/experience-motion.js',
  'docs/litepaper/assets/agent-computer-hero-v2.png',
  'docs/litepaper/assets/agent-computer-opportunity-v2.png',
  'docs/litepaper/assets/observable-run-v2.png',
  'docs/litepaper/assets/boundary-monolith-v5.png',
  'docs/litepaper/assets/agent-computer-hero-v2-768.webp',
  'docs/litepaper/assets/agent-computer-hero-v2-1536.webp',
  'docs/litepaper/assets/agent-computer-opportunity-v2-768.webp',
  'docs/litepaper/assets/agent-computer-opportunity-v2-1536.webp',
  'docs/litepaper/assets/observable-run-v2-768.webp',
  'docs/litepaper/assets/observable-run-v2-1536.webp',
  'docs/litepaper/assets/fonts/Manrope-Variable.ttf',
  'docs/litepaper/assets/fonts/Manrope-OFL.txt',
  'docs/litepaper/assets/fonts/IBMPlexMono-Regular.ttf',
  'docs/litepaper/assets/fonts/IBMPlexMono-OFL.txt',
  'docs/litepaper/vendor/gsap-3.15.0.min.js',
  'docs/litepaper/vendor/ScrollTrigger-3.15.0.min.js',
  'docs/litepaper/vendor/NOTICE.md',
]);

/** Token-free documents, also published as static files: source in the repository, public path beside the app's own. */
export const RESTRICTED_COPIES = Object.freeze([
  ['docs/litepaper/restricted/LITEPAPER.md', 'restricted/LITEPAPER.md'],
  ['docs/litepaper/restricted/WHITEPAPER.md', 'restricted/WHITEPAPER.md'],
  ['docs/litepaper/restricted/TOKENOMICS.md', 'restricted/TOKENOMICS.md'],
]);

/**
 * The four documents the token geo-policy applies to. `name` is the file name
 * under GEO_DOCUMENTS_DIRECTORY/full and GEO_DOCUMENTS_DIRECTORY/restricted;
 * `route` is the address the route handler answers. They are never copied into
 * public/.
 */
export const GEO_DOCUMENTS = Object.freeze([
  { name: 'LITEPAPER.md', route: '/LITEPAPER.md', full: 'LITEPAPER.md', restricted: 'docs/litepaper/restricted/LITEPAPER.md' },
  { name: 'WHITEPAPER.md', route: '/WHITEPAPER.md', full: 'WHITEPAPER.md', restricted: 'docs/litepaper/restricted/WHITEPAPER.md' },
  { name: 'TOKENOMICS.md', route: '/TOKENOMICS.md', full: 'TOKENOMICS.md', restricted: 'docs/litepaper/restricted/TOKENOMICS.md' },
  { name: 'litepaper.html', route: '/docs/litepaper/index.html', full: 'docs/litepaper/index.html', restricted: 'docs/litepaper/restricted.html' },
]);
/** Relative to dashboard/. Must match GEO_DOCUMENTS_DIRECTORY in src/lib/compliance/token-geo-documents.ts. */
export const GEO_DOCUMENTS_DIRECTORY = '.generated/litepaper';
const GEO_VARIANTS = Object.freeze(['full', 'restricted']);

/** Paths under public/ that an earlier release staged and that must never be there again. */
export const FORBIDDEN_PUBLIC_PATHS = Object.freeze(GEO_DOCUMENTS.map(({ full }) => full));

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
  rejectSymlinks(dashboardRoot, GEO_DOCUMENTS_DIRECTORY);
  rejectSymlinks(repoRoot, 'LITEPAPER.md');
  const litepaperHash = createHash('sha256').update(readFileSync(path.join(repoRoot, 'LITEPAPER.md'))).digest('hex');
  if (litepaperHash !== approvedSha256) {
    throw new Error('LITEPAPER.md differs from the current user-approved source.');
  }

  // Complete validation before writing: an absent asset must not leave a partial package.
  const publicPairs = [
    ...LITEPAPER_FILES.map((relative) => [relative, relative]),
    ...RESTRICTED_COPIES,
  ].map(([relative, publicRelative]) => [relative, `public/${publicRelative}`]);
  const geoPairs = GEO_DOCUMENTS.flatMap((document) => GEO_VARIANTS.map((variant) => [
    document[variant], `${GEO_DOCUMENTS_DIRECTORY}/${variant}/${document.name}`,
  ]));
  const files = [...publicPairs, ...geoPairs].map(([relative, stagedRelative]) => {
    rejectSymlinks(repoRoot, relative);
    rejectSymlinks(dashboardRoot, stagedRelative);
    const source = path.join(repoRoot, relative);
    if (!lstatSync(source).isFile()) throw new Error(`Not a regular litepaper file: ${relative}`);
    return { relative: stagedRelative, source, target: path.join(dashboardRoot, stagedRelative), bytes: readFileSync(source) };
  });
  const expected = new Set(files.map(({ relative }) => relative));
  const forbidden = FORBIDDEN_PUBLIC_PATHS.filter((relative) => {
    rejectSymlinks(publicRoot, relative);
    return existsSync(path.join(publicRoot, relative));
  });
  const unexpected = [
    ...existingFiles(dashboardRoot, 'public/docs/litepaper'),
    ...existingFiles(dashboardRoot, 'public/restricted'),
    ...existingFiles(dashboardRoot, GEO_DOCUMENTS_DIRECTORY),
  ].filter((relative) => !expected.has(relative) && !forbidden.includes(relative.replace(/^public\//, '')));
  if (unexpected.length) throw new Error(`Unexpected file in the generated litepaper directory: ${unexpected.join(', ')}`);
  if (check && forbidden.length) {
    throw new Error(`A full token document is published from public/: ${forbidden.join(', ')}`);
  }
  const stale = files.filter(({ target, bytes }) => !existsSync(target) || !readFileSync(target).equals(bytes));
  if (check && stale.length) throw new Error(`Litepaper staging is stale: ${stale.map(({ relative }) => relative).join(', ')}`);
  if (!check) {
    // Earlier releases published these from public/. They are this script's own
    // output (git-ignored), so a stale copy in a working tree is removed rather
    // than left to answer the address.
    for (const relative of forbidden) rmSync(path.join(publicRoot, relative), { force: true });
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
  return { files: files.length, updated: check ? 0 : stale.length + forbidden.length };
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
