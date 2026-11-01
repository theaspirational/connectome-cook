/** Private directory provisioning for the effective user, never chmod/chown.
 * Linux descriptor-relative traversal rejects symlinks even in ancestors.
 * Existing ancestors need not be private; the declared root must be 0700.
 * Same-uid processes are trusted, as for privateWrite. */
import { closeSync, constants as F, fstatSync, mkdirSync, openSync } from 'node:fs';
import { privatePathParts, PrivateWriteError } from './private-write.js';

export function provisionPrivateDirectory(root: string, create = true): void {
  const dirs: number[] = [];
  try {
    if (process.platform !== 'linux' || process.geteuid?.() === undefined) throw new PrivateWriteError('E_PRIVATE_UNSUPPORTED');
    if (typeof root !== 'string' || !root.startsWith('/')) throw new PrivateWriteError('E_PRIVATE_PATH');
    const parts = privatePathParts(root.slice(1));
    let fd = openSync('/', F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW); dirs.push(fd);
    for (const part of parts) {
      const path = '/proc/self/fd/' + fd + '/' + part;
      let next: number;
      try { next = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!create) return;
        mkdirSync(path, { mode: 0o700 });
        next = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
      }
      fd = next; dirs.push(fd);
    }
    const s = fstatSync(fd);
    if (s.uid !== process.geteuid!()) throw new PrivateWriteError('E_PRIVATE_OWNER');
    if ((s.mode & 0o7777) !== 0o700) throw new PrivateWriteError('E_PRIVATE_MODE');
  } catch (error) {
    throw error instanceof PrivateWriteError ? error : new PrivateWriteError('E_PRIVATE_PATH');
  } finally { for (const fd of dirs.reverse()) closeSync(fd); }
}
