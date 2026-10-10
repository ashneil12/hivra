'use strict';
const fs = require('node:fs');
const path = require('node:path');

// This is a dashboard disclosure guard, not a sandbox for code running as the
// computer's owner. In particular, an owner can deliberately copy credentials.
const SECRET_RE = /(\.credentials\.(?:json|ya?ml)|(?:^|\/)\.env(?:\.|$)|browser\.env|auth\.json|api-token|llm-provider\.json|\/\.ssh(?:\/|$)|token|secret|\.pem$|\.key$)/i;
function protectedPath(filename) {
  return SECRET_RE.test(filename) || /(?:^|\/)\.dsh(?:\/|$)/.test(filename)
    || /(?:^|\/)\.hivra\/deepseek(?:\/|$)/.test(filename)
    // The gateway's saved surface sign-ins (and its temp files while saving).
    || /(?:^|\/)\.hivra\/\.?surface-sessions\./.test(filename);
}
function denied() { return Object.assign(new Error('file access denied'), { code: 'HIVRA_FILE_DENIED' }); }

/** Linux descriptor-relative traversal. Each ancestor is opened without
 * following links; the final descriptor is inspected before any read/write.
 * Never substitute realpath-then-open (a directory can change in between).
 */
function createGuardedFiles(home) {
  function open(relative, flags) {
    if (process.platform !== 'linux') throw denied();
    if (typeof relative !== 'string' || relative.includes('\0')) throw denied();
    const filename = path.resolve(home, relative);
    if (filename !== home && !filename.startsWith(home + '/')) throw denied();
    if (protectedPath(filename)) throw denied();
    const parts = path.relative(home, filename).split('/').filter(Boolean);
    let parent = fs.openSync(home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      // HOME is operator-configured, but must not itself alias another tree.
      if (fs.realpathSync(home) !== home) throw denied();
      while (parts.length > 1) {
        const next = fs.openSync(`/proc/self/fd/${parent}/${parts.shift()}`,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        fs.closeSync(parent); parent = next;
      }
      const fd = parts.length ? fs.openSync(`/proc/self/fd/${parent}/${parts[0]}`,
        flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) : fs.openSync(`/proc/self/fd/${parent}`, flags);
      try {
        // Also reject an ancestor moved out of HOME or into the private tree
        // during traversal, before using the already-opened descriptor.
        const actual = fs.readlinkSync(`/proc/self/fd/${fd}`);
        if (actual !== filename || protectedPath(actual)) throw denied();
        const info = fs.fstatSync(fd);
        if (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw denied();
        return { fd, info, filename };
      } catch (error) { fs.closeSync(fd); throw error; }
    } finally { fs.closeSync(parent); }
  }
  function read(relative, limit) {
    const file = open(relative, fs.constants.O_RDONLY);
    try {
      if (!file.info.isFile()) throw denied();
      if (file.info.size > limit) throw Object.assign(new Error('file too large'), { code: 'HIVRA_FILE_SIZE' });
      // Bound the actual read as well as stat: another process may append.
      const bytes = Buffer.alloc(limit + 1);
      let size = 0;
      while (size <= limit) {
        const count = fs.readSync(file.fd, bytes, size, bytes.length - size, size);
        if (!count) break;
        size += count;
      }
      if (size > limit) throw Object.assign(new Error('file too large'), { code: 'HIVRA_FILE_SIZE' });
      return { path: path.relative(home, file.filename), size, content: bytes.subarray(0, size).toString('utf8') };
    } finally { fs.closeSync(file.fd); }
  }
  function write(relative, content) {
    // No O_TRUNC until the descriptor passed the path/type/link checks.
    const file = open(relative, fs.constants.O_WRONLY);
    try {
      if (!file.info.isFile()) throw denied();
      fs.writeFileSync(file.fd, content); fs.ftruncateSync(file.fd, Buffer.byteLength(content));
      return { ok: true, path: path.relative(home, file.filename), size: Buffer.byteLength(content) };
    } finally { fs.closeSync(file.fd); }
  }
  function list(relative) {
    const directory = open(relative, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      const entries = [];
      for (const name of fs.readdirSync(`/proc/self/fd/${directory.fd}`)) {
        if (protectedPath(path.join(directory.filename, name))) continue;
        let child;
        try {
          child = open(path.join(path.relative(home, directory.filename), name), fs.constants.O_RDONLY);
          entries.push({ name, type: child.info.isDirectory() ? 'dir' : 'file', size: child.info.size, mtime: Math.floor(child.info.mtimeMs) });
        } catch { /* Do not reveal links, special files or inaccessible entries. */ }
        finally { if (child) fs.closeSync(child.fd); }
      }
      entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
      return { path: path.relative(home, directory.filename) || '.', entries };
    } finally { fs.closeSync(directory.fd); }
  }
  function inspectFile(relative, allowMissing = false) {
    let file;
    try { file = open(relative, fs.constants.O_RDONLY); }
    catch (error) {
      if (!allowMissing || error.code !== 'ENOENT') throw error;
      // A whole Git directory may have been deleted. Validate the nearest
      // surviving ancestor; every existing component still rejects aliases.
      const filename = path.resolve(home, relative);
      if (protectedPath(filename)) throw denied();
      let ancestor = path.dirname(filename);
      for (;;) {
        try {
          const parent = open(ancestor, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
          fs.closeSync(parent.fd); break;
        } catch (parentError) {
          if (parentError.code !== 'ENOENT' || ancestor === home) throw parentError;
          ancestor = path.dirname(ancestor);
        }
      }
      return { exists: false, filename };
    }
    try {
      if (!file.info.isFile()) throw denied();
      return { exists: true, filename: file.filename, size: file.info.size };
    } finally { fs.closeSync(file.fd); }
  }
  return Object.freeze({ list, read, write, inspectFile });
}
module.exports = { createGuardedFiles, protectedPath };
