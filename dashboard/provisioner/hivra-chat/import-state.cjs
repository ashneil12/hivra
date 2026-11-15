'use strict';
// Moving an existing agent to this box. The owner (or a one-time transfer
// token the gateway minted) pushes a .tar.gz state bundle to /api/import;
// this module unpacks it safely and lands it where the agent keeps its data.
//
// Two target shapes:
//   home   the archive mirrors the agent's HOME. Allowlisted top-level
//          entries merge into HOME; anything under a work/ prefix lands at
//          HOME root so project folders can come too. Existing files are
//          kept unless the bundle replaces them; nothing is deleted.
//   a0-usr the archive is the contents of Agent Zero's persisted /a0/usr
//          volume, restored as a full replace while its container is down.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// What may NEVER be written by an import: the gateway's own control files,
// sign-in material unrelated to the agent, and anything the box runs at
// login or boot. Matched as a HOME-relative path or any of its ancestors.
const HOME_DENY_ROOTS = [
  '.hivra',
  '.ssh',
  '.gnupg',
  '.docker',
  '.bashrc', '.bash_profile', '.bash_logout', '.profile',
  '.zshrc', '.zshenv', '.zprofile', '.zlogin',
  '.config/systemd', '.config/autostart', '.config/environment.d',
  'system-prompt.md', 'hivra-agent-shell',
];

// Per-kind allowed top-level entries for home-mode bundles. Extra roots can be
// seeded per box in ~/.hivra/import-roots (one entry per line) so a new agent
// kind can declare its state dirs without a code change.
const HOME_ROOTS = {
  claude: ['.claude', '.claude.json', '.agents', 'CLAUDE.md', 'USER.md', 'MEMORY.md'],
  codex: ['.codex', '.agents', 'AGENTS.md'],
  openclaw: ['.openclaw'],
  generic: [],
};

function extraRoots(home) {
  try {
    return fs.readFileSync(path.join(home, '.hivra', 'import-roots'), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch { return []; }
}

/** The import contract for one agent kind, or null when it has nothing movable. */
function specFor(kind, home, env) {
  if (kind === 'agent-zero') {
    return { mode: 'a0-usr', usr: (env && env.HIVRA_A0_USR) || '/opt/a0/usr' };
  }
  const roots = HOME_ROOTS[kind];
  if (!roots) return null;
  return { mode: 'home', home, roots: roots.concat(extraRoots(home)), workPrefix: 'work' };
}

function isDeniedHome(rel) {
  const norm = rel.split(path.sep).join('/');
  return HOME_DENY_ROOTS.some((deny) => norm === deny || norm.startsWith(deny + '/'));
}

/** Member names from `tar -t` (literal quoting). Anything unsafe rejects the
 *  whole bundle — a quiet partial restore is worse than a loud refusal. */
function validateMemberNames(raw) {
  const cleaned = [];
  const bad = [];
  for (const line of String(raw).split('\n')) {
    if (!line) continue;
    let name = line;
    if (name.endsWith('/')) name = name.slice(0, -1);
    while (name.startsWith('./')) name = name.slice(2);
    if (!name || name === '.') continue;
    const unsafe = name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)
      || name.includes('\0') || name.includes('\n')
      || name.split('/').some((seg) => seg === '..');
    if (unsafe) bad.push(line); else cleaned.push(name);
  }
  return { ok: bad.length === 0 && cleaned.length > 0, cleaned, bad };
}

/** Post-extraction sweep of the staging tree: drop anything that is not a
 *  regular file, directory or a symlink that stays inside the tree. GNU tar
 *  already refuses ../ and absolute members on extract; this is the second net. */
function sanitizeExtracted(root) {
  let removed = 0;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (st.isFile()) continue;
      if (st.isSymbolicLink()) {
        const target = fs.readlinkSync(p);
        const resolved = path.resolve(dir, target);
        if (resolved === root || resolved.startsWith(root + path.sep)) continue;
      }
      fs.rmSync(p, { force: true });
      removed += 1;
    }
  };
  walk(root);
  return removed;
}

/** Merge src into dst. deny(rel) skips entries (reported, not copied); prune
 *  also removes dst entries the bundle does not carry (full-replace restores).
 *  src may be a directory (its contents merge into dst) or a single file. */
function syncTree(src, dst, options) {
  const opts = options || {};
  const report = { files: 0, dirs: 0, skipped: [] };
  const skip = (rel, why) => report.skipped.push(rel + (why ? ' (' + why + ')' : ''));
  const rmAny = (p) => fs.rmSync(p, { recursive: true, force: true });
  const exists = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) != null;
  const seen = new Set();

  const copy = (s, d, rel) => {
    if (opts.deny && opts.deny(rel)) { skip(rel, 'protected'); return; }
    const st = fs.lstatSync(s);
    seen.add(rel.split(path.sep).join('/'));
    if (st.isDirectory()) {
      const at = fs.lstatSync(d, { throwIfNoEntry: false });
      if (at && !at.isDirectory()) rmAny(d);
      if (!at) { fs.mkdirSync(d, { mode: st.mode & 0o777 }); report.dirs += 1; }
      for (const name of fs.readdirSync(s)) {
        copy(path.join(s, name), path.join(d, name), path.join(rel, name));
      }
      return;
    }
    if (exists(d)) rmAny(d);
    if (st.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(s), d);
      report.files += 1;
      return;
    }
    if (!st.isFile()) { skip(rel, 'not a file'); return; }
    fs.copyFileSync(s, d);
    try { fs.chmodSync(d, st.mode & 0o777); } catch {}
    try { fs.utimesSync(d, st.atime, st.mtime); } catch {}
    report.files += 1;
  };

  const top = fs.lstatSync(src);
  if (!top.isDirectory()) { copy(src, dst, path.basename(src)); return report; }
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) copy(path.join(src, name), path.join(dst, name), name);

  if (opts.prune) {
    const prune = (dir, rel) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const r = rel ? path.join(rel, name) : name;
        if (!seen.has(r.split(path.sep).join('/'))) { rmAny(p); continue; }
        if (fs.lstatSync(p).isDirectory()) prune(p, r);
      }
    };
    prune(dst, '');
  }
  return report;
}

function exec(cmd, args, execFileImpl) {
  return new Promise((resolve, reject) => {
    (execFileImpl || execFile)(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr || '') }));
      else resolve(String(stdout || ''));
    });
  });
}

// Boxes run GNU tar, which takes the strict quoting and permission flags; fall
// back to the plain form for tars that lack them (bsdtar, busybox).
async function execTar(args, fallbackArgs, execFileImpl) {
  try { return await exec('tar', args, execFileImpl); }
  catch (error) {
    if (!fallbackArgs) throw error;
    return exec('tar', fallbackArgs, execFileImpl);
  }
}

/**
 * Restore one uploaded bundle. onPhase(name, detail) tracks progress for
 * GET /api/import/status. Resolves with what was restored; rejects on a clean,
 * user-readable error.
 */
async function runImport(input) {
  const { archive, spec, execFileImpl, onPhase } = input;
  const phase = (name, detail) => { if (onPhase) onPhase(name, detail); };

  phase('unpacking', 'Checking the bundle');
  const listing = await execTar(['-tzf', archive, '--quoting-style=literal'], ['-tzf', archive], execFileImpl)
    .catch(() => { throw new Error('That file is not a readable .tar.gz archive.'); });
  const names = validateMemberNames(listing);
  if (names.bad.length) {
    throw new Error('The bundle contains unsafe paths and was refused: ' + names.bad.slice(0, 3).join(', '));
  }
  if (!names.cleaned.length) throw new Error('The bundle is empty.');

  const staging = fs.mkdtempSync(path.join(input.stagingParent, 'import-'));
  try {
    await execTar(
      ['-xzf', archive, '-C', staging, '--no-same-owner', '--preserve-permissions'],
      ['-xzf', archive, '-C', staging],
      execFileImpl,
    ).catch(() => { throw new Error('Could not unpack the bundle.'); });
    const removed = sanitizeExtracted(staging);

    phase('restoring', 'Writing the agent state');
    const restored = [];
    const skipped = [];
    let files = 0;
    if (spec.mode === 'a0-usr') {
      // The volume is 0777 so the box user can write it; the container must be
      // stopped first or it overwrites the restore on shutdown. The scoped
      // helper (sudo, provisioned on agent-zero boxes) does stop + restart.
      const helper = '/usr/local/bin/hivra-agent-zero-apply';
      if (!fs.existsSync(helper)) throw new Error('This box cannot take an Agent Zero restore yet (runtime too old).');
      phase('restoring', 'Stopping Agent Zero');
      await exec('sudo', ['-n', helper, 'stop'], execFileImpl)
        .catch(() => { throw new Error('Could not stop Agent Zero for the restore.'); });
      try {
        const r = syncTree(staging, spec.usr, { prune: true });
        files += r.files; skipped.push(...r.skipped);
        restored.push('/a0/usr');
      } finally {
        phase('restarting', 'Starting Agent Zero');
        await exec('sudo', ['-n', helper, 'restart'], execFileImpl).catch(() => {});
      }
    } else {
      for (const name of fs.readdirSync(staging)) {
        if (name === spec.workPrefix) {
          // work/<folder> in the bundle means "this folder lives at HOME/<folder>".
          const workDir = path.join(staging, name);
          if (!fs.lstatSync(workDir).isDirectory()) continue;
          for (const inner of fs.readdirSync(workDir)) {
            if (isDeniedHome(inner)) { skipped.push(inner + ' (protected)'); continue; }
            const r = syncTree(path.join(workDir, inner), path.join(spec.home, inner), { deny: isDeniedHome });
            files += r.files; skipped.push(...r.skipped);
            restored.push(inner);
          }
          continue;
        }
        // The allowlist is checked on the bundle's top-level names; the deny
        // net below also guards it, in case an allowlisted name ever overlaps
        // a protected root (say, a seeded import-roots file gone wrong).
        if (!spec.roots.includes(name) || isDeniedHome(name)) { skipped.push(name + (isDeniedHome(name) ? ' (protected)' : ' (not agent state)')); continue; }
        const r = syncTree(path.join(staging, name), path.join(spec.home, name), { deny: isDeniedHome });
        files += r.files; skipped.push(...r.skipped);
        restored.push(name);
      }
    }
    return { restored, skipped, files, removedUnsafe: removed };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
  }
}

module.exports = {
  HOME_DENY_ROOTS,
  specFor,
  isDeniedHome,
  validateMemberNames,
  sanitizeExtracted,
  syncTree,
  runImport,
};
