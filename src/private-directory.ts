/** Private directory provisioning for the effective user, never chmod/chown.
 * Linux descriptor-relative traversal rejects symlinks even in ancestors.
 * Writable ancestors must be sticky and owned by root or the effective user.
 * Foreign non-root ancestors always refuse; the root must be 0700.
 * Same-uid processes are trusted. */
import { dirname, join } from 'node:path';
import { closeSync, constants as F, fchmodSync, fstatSync, fsyncSync, lstatSync, readlinkSync, realpathSync, mkdirSync, openSync, writeFileSync, renameSync, unlinkSync, type Stats } from 'node:fs';
class PrivateDirectoryError extends Error {}
export function privatePathParts(path: string): string[] {
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[\0-\x1f\x7f]/.test(p))) throw new PrivateDirectoryError('E_PRIVATE_PATH');
  return parts;
}

function dependencyPathParts(path: string): string[] {
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part))) throw new PrivateDirectoryError('E_PRIVATE_PATH');
  return parts;
}

/** Resolve existing ancestors without trusting links controlled by another user.
 * Missing suffixes are preserved, so preflight never creates directories. */
export function resolvePrivateDirectoryPath(root: string): string {
  if (!root.startsWith('/')) throw new PrivateDirectoryError('E_PRIVATE_PATH');
  let parts = dependencyPathParts(root.slice(1)), current = '/', links = 0;
  while (parts.length) {
    const part = parts.shift()!;
    if (part === '..') { current = dirname(current); continue; }
    const path = join(current, part);
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return join(realpathSync(current), part, ...parts);
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (stat.uid !== 0 && stat.uid !== process.geteuid?.()) throw new PrivateDirectoryError('E_PRIVATE_LINK_OWNER');
      if (++links > 40) throw new PrivateDirectoryError('E_PRIVATE_PATH');
      const target = readlinkSync(path);
      // Walk target components before resolving '..': a target may itself
      // traverse a link, whose owner must be checked too.
      parts = [...target.split('/').filter(part => part && part !== '.'), ...parts];
      if (target.startsWith('/')) current = '/';
    } else {
      if (!stat.isDirectory()) throw new PrivateDirectoryError('E_PRIVATE_PATH');
      current = path;
    }
  }
  return realpathSync(current);
}

/** Split layouts reject all symlinks and unsafe ancestors. Dependency storage
 * retains its canonical, trusted-link policy and permits nonprivate ancestors. */
export function provisionPrivateDirectory(root: string, create = true, policy: 'layout' | 'dependency' = 'layout'): Stats | undefined {
  const dirs: number[] = [];
  try {
    if (process.platform !== 'linux' || process.geteuid?.() === undefined) throw new PrivateDirectoryError('E_PRIVATE_UNSUPPORTED');
    if (typeof root !== 'string' || !root.startsWith('/')) throw new PrivateDirectoryError('E_PRIVATE_PATH');
    const parts = policy === 'dependency' ? dependencyPathParts(resolvePrivateDirectoryPath(root).slice(1)) : privatePathParts(root.slice(1));
    let fd = openSync('/', F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW); dirs.push(fd);
    // Missing /proc must not masquerade as a missing declared root.
    const probe = openSync('/proc/self/fd/' + fd, F.O_RDONLY | F.O_DIRECTORY);
    closeSync(probe);
    for (const [index, part] of parts.entries()) {
      const ancestor = fstatSync(fd);
      const trustedOwner = ancestor.uid === 0 || ancestor.uid === process.geteuid!();
      if (policy === 'layout' && (!trustedOwner || ((ancestor.mode & 0o022) && !(ancestor.mode & 0o1000)))) throw new PrivateDirectoryError('E_PRIVATE_ANCESTOR');
      const path = '/proc/self/fd/' + fd + '/' + part;
      let next: number;
      try { next = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!create) return;
        mkdirSync(path, { mode: policy === 'layout' || index === parts.length - 1 ? 0o700 : 0o777 });
        fsyncSync(fd);
        next = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
      }
      fd = next; dirs.push(fd);
    }
    if (create) fsyncSync(fd);
    const s = fstatSync(fd);
    if (s.uid !== process.geteuid!()) throw new PrivateDirectoryError('E_PRIVATE_OWNER');
    if ((s.mode & 0o7777) !== 0o700) throw new PrivateDirectoryError('E_PRIVATE_MODE');
    return s;
  } catch (error) {
    throw error instanceof PrivateDirectoryError ? error : new PrivateDirectoryError('E_PRIVATE_PATH');
  } finally { for (const fd of dirs.reverse()) closeSync(fd); }
}

function assertPrivateFile(fd: number): void {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.geteuid!() || stat.nlink !== 1) throw new PrivateDirectoryError('E_PRIVATE_FILE');
}

/** Atomic replacement in the same private directory; no truncated control files. */
export function writePrivateLayoutFile(path: string, content: string, mode: number): void {
  provisionPrivateDirectory(dirname(path));
  let existing: number | undefined;
  try {
    existing = openSync(path, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
    assertPrivateFile(existing);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally { if (existing !== undefined) closeSync(existing); }
  const temp = path + '.tmp-' + crypto.randomUUID();
  let fd: number | undefined;
  try {
    fd = openSync(temp, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
    assertPrivateFile(fd);
    fchmodSync(fd, mode);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, path);
    const parent = openSync(dirname(path), F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
