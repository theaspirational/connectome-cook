/** Private, atomic single-file replacement. Linux /proc descriptor paths give
 * Node's path-based calls directory-relative, no-follow traversal semantics. */
import { constants as F, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';

export class PrivateWriteError extends Error {
  constructor(public readonly code: 'E_PRIVATE_PATH' | 'E_PRIVATE_OWNER' | 'E_PRIVATE_MODE' | 'E_PRIVATE_IO' | 'E_PRIVATE_UNSUPPORTED') { super(code); }
}
function refuse(code: PrivateWriteError['code']): never { throw new PrivateWriteError(code); }
export interface PrivateWriteOptions {
  mode?: 0o600 | 0o400;
  allowTightening?: boolean;
  /** Isolated fault/stat injection for tests; never populated from config. */
  test?: {
    stat?: (path: string) => Stats;
    write?: (fd: number, bytes: Uint8Array, offset: number, length: number) => number;
    point?: (point: 'created' | 'written' | 'file-synced') => void;
    sync?: (fd: number) => void;
  };
}
export interface PrivateWriteResult { durability: 'synced' | 'uncertain' }

/** Strict relative names: reject traversal BEFORE normalization. */
export function privatePathParts(path: string): string[] {
  if (typeof path !== 'string' || !path || /[\\\0]/.test(path)) refuse('E_PRIVATE_PATH');
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) refuse('E_PRIVATE_PATH');
  return parts;
}
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

/** Parents must already exist, owned by the effective user, mode 0700. No
 * mkdir, chmod of existing files, directory replacement, or sibling scanning.
 * The declared root and its parents must not be symlinks. Serialize writers
 * to the SAME file; processes under the same uid are a trusted boundary. */
export function privateWrite(root: string, path: string, value: string | Uint8Array, options: PrivateWriteOptions = {}): PrivateWriteResult {
  const dirs: number[] = [];
  let temp: string | undefined, tempFd: number | undefined, inode: Stats | undefined;
  let committed = false;
  const stat = options.test?.stat ?? lstatSync;
  const sync = options.test?.sync ?? fsyncSync;
  const observe = (p: string): Stats | undefined => {
    try { return stat(p); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };
  try {
    const uid = process.geteuid?.();
    if (process.platform !== 'linux' || uid === undefined) refuse('E_PRIVATE_UNSUPPORTED');
    const parts = privatePathParts(path);
    if (typeof root !== 'string' || !root.startsWith('/')) refuse('E_PRIVATE_PATH');
    const rootParts = privatePathParts(root.slice(1));
    const mode = options.mode ?? 0o600;
    if (mode !== 0o600 && mode !== 0o400) refuse('E_PRIVATE_MODE');
    const checkDir = (s: Stats): void => {
      if (!s.isDirectory()) refuse('E_PRIVATE_PATH');
      if (s.uid !== uid) refuse('E_PRIVATE_OWNER');
      if ((s.mode & 0o7777) !== 0o700) refuse('E_PRIVATE_MODE');
    };
    let parent = openSync('/', F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
    dirs.push(parent);
    for (const part of rootParts) {
      parent = openSync(`/proc/self/fd/${parent}/${part}`, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
      dirs.push(parent);
    }
    checkDir(fstatSync(parent));
    for (const part of parts.slice(0, -1)) {
      parent = openSync(`/proc/self/fd/${parent}/${part}`, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
      dirs.push(parent); checkDir(fstatSync(parent));
    }
    const target = `/proc/self/fd/${parent}/${parts.at(-1)!}`;
    const checkFile = (s: Stats): void => {
      if (!s.isFile() || s.nlink !== 1) refuse('E_PRIVATE_PATH');
      if (s.uid !== uid) refuse('E_PRIVATE_OWNER');
      if ((s.mode & 0o7777) !== mode && !options.allowTightening) refuse('E_PRIVATE_MODE');
      // Tightening may remove permissions, never add them to an existing file.
      if (options.allowTightening && ((s.mode & mode) !== mode)) refuse('E_PRIVATE_MODE');
    };
    const before = observe(target);
    if (before) checkFile(before);
    temp = `/proc/self/fd/${parent}/.cook-private-${randomUUID()}`;
    tempFd = openSync(temp, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, mode);
    inode = fstatSync(tempFd);
    fchmodSync(tempFd, mode); // exact declared mode, independent of umask
    options.test?.point?.('created');
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const write = options.test?.write ?? ((fd, data, offset, length) => writeSync(fd, data, offset, length));
    for (let offset = 0; offset < bytes.byteLength;) {
      const n = write(tempFd, bytes, offset, bytes.byteLength - offset);
      if (!Number.isInteger(n) || n <= 0 || n > bytes.byteLength - offset) refuse('E_PRIVATE_IO');
      offset += n;
    }
    options.test?.point?.('written'); sync(tempFd); options.test?.point?.('file-synced');
    const now = observe(target);
    if (now) checkFile(now);
    if (!!before !== !!now || (before && now && !same(before, now))) refuse('E_PRIVATE_PATH');
    const staged = observe(temp);
    if (!staged || !same(inode, staged)) refuse('E_PRIVATE_PATH');
    checkFile(staged);
    renameSync(temp, target); committed = true;
    // Rename is the commit point. A subsequent directory-sync failure cannot
    // safely undo publication: report committed but uncertain, never a false
    // pre-commit failure. Callers must not automatically retry this outcome.
    try { sync(parent); return { durability: 'synced' }; }
    catch { return { durability: 'uncertain' }; }
  } catch (error) {
    throw error instanceof PrivateWriteError ? error : new PrivateWriteError('E_PRIVATE_IO');
  } finally {
    // Remove only our temp inode, never another writer's files.
    try {
      if (!committed && temp && inode) {
        const staged = observe(temp);
        if (staged && same(staged, inode)) unlinkSync(temp);
      }
    } catch { /* Cleanup errors must not expose paths or payloads. */ }
    if (tempFd !== undefined) { try { closeSync(tempFd); } catch { /* no payload in errors */ } }
    for (const fd of dirs.reverse()) { try { closeSync(fd); } catch { /* no payload in errors */ } }
  }
}
