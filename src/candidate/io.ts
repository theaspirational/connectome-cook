import { constants as F, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmdirSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, parse } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CandidateError, fail, parseJSON, validate, type Records } from './schema.js';

export function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; return fail('E_IO', 3); }
}
/** Inspect every ancestor without following symlinks. Parent ownership is not
 * ours to change (e.g. /tmp); candidate directories themselves are private. */
export function noLinks(path: string): void {
  const full = resolve(path); let current = parse(full).root;
  for (const part of full.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    const s = lstatSync(current);
    if (s.isSymbolicLink()) fail('E_PATH');
    if (current !== full && !s.isDirectory()) fail('E_PATH');
  }
}
export function privateDir(path: string): void {
  noLinks(path); const s = lstatSync(path);
  if (!s.isDirectory()) fail('E_PATH');
  if (s.uid !== process.getuid?.() || (s.mode & 0o7777) !== 0o700) fail('E_MODE');
}
export function privateFile(path: string, mode = 0o600): void {
  noLinks(path); const s = lstatSync(path);
  if (!s.isFile() || s.nlink !== 1) fail('E_PATH');
  if (s.uid !== process.getuid?.() || (s.mode & 0o7777) !== mode) fail('E_MODE');
}
export function readPrivate(path: string): string {
  privateFile(path);
  const fd = openSync(path, F.O_RDONLY | F.O_NOFOLLOW);
  try {
    const s = fstatSync(fd), before = lstatSync(path);
    if (s.ino !== before.ino || s.dev !== before.dev || s.nlink !== 1 || !s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o7777) !== 0o600) fail('E_MODE');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
export function readRecord<K extends keyof Records>(root: string, path: string, schema: K): Records[K] {
  privateDir(root); privateDir(join(root, '.cook'));
  if (path.startsWith('data/')) privateDir(join(root, 'data'));
  return validate(schema, parseJSON(readPrivate(join(root, path))));
}
export function syncDir(path: string): void {
  const fd = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Flush materialized files/directories before publishing the lock. Symlinks
 * are persisted via their containing directory, never followed outside R. */
export function syncTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) syncTree(join(path, entry));
    syncDir(path);
  } else if (stat.isFile()) {
    const fd = openSync(path, F.O_RDONLY | F.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } else fail('E_IO', 3);
}
export function ioError(error: unknown): CandidateError { return error instanceof CandidateError ? error : new CandidateError('E_IO', 3); }

/** No-replace publisher. Fault hooks are dependency injection for isolated tests,
 * never environment/CLI options. Unknown surviving hardlinks are not adopted. */
export type PublishPoint = 'created' | 'written' | 'file-synced' | 'linked' | 'parent-synced' | 'temp-removed' | 'done';
export function publish(path: string, bytes: string, options: { identical?: boolean; point?: (point: PublishPoint) => void } = {}): void {
  const parent = dirname(path); noLinks(parent);
  const temp = join(parent, `.cook-tmp-${randomUUID()}`);
  let fd: number | undefined, inode: { ino: number; dev: number } | undefined;
  try {
    fd = openSync(temp, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
    inode = fstatSync(fd); options.point?.('created');
    writeFileSync(fd, bytes); options.point?.('written');
    fsyncSync(fd); options.point?.('file-synced'); closeSync(fd); fd = undefined;
    try { linkSync(temp, path); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (!options.identical) fail('E_SEED_CONFLICT');
      if (readPrivate(path) !== bytes) fail('E_SEED_CONFLICT');
    }
    options.point?.('linked'); syncDir(parent); options.point?.('parent-synced');
    const s = lstatSync(temp);
    if (s.ino !== inode.ino || s.dev !== inode.dev) fail('E_PATH');
    unlinkSync(temp); options.point?.('temp-removed'); syncDir(parent); options.point?.('done');
  } catch (e) { throw ioError(e); }
  finally {
    if (fd !== undefined) closeSync(fd);
    // Only this invocation's inode is eligible for cleanup. Never glob temps.
    if (inode && exists(temp)) {
      const s = lstatSync(temp);
      if (s.ino === inode.ino && s.dev === inode.dev) { unlinkSync(temp); syncDir(parent); }
    }
  }
}

export type LockHelper = (fd: number) => number | null;
export const flock: LockHelper = fd => {
  const p = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 5000 });
  return p.error ? null : p.status;
};
export function admitLocalFilesystem(path: string, platform = process.platform): void {
  if (platform !== 'linux') fail('E_IO', 3);
  noLinks(path);
  // Explicitly admitted local Linux filesystem implementations; everything
  // else (including NFS, CIFS, FUSE and unknown overlay backing) fails closed.
  if (![0xef53, 0x58465342, 0x9123683e, 0x01021994].includes(statfsSync(path).type >>> 0)) fail('E_IO', 3);
}
export function admitFilesystem(path: string, platform = process.platform): void {
  admitLocalFilesystem(path, platform);
  const version = spawnSync('/usr/bin/flock', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (version.status !== 0 || !version.stdout.includes('util-linux')) fail('E_IO', 3);
}
export function preflight(parent: string, helper: LockHelper = flock): void {
  admitFilesystem(parent); // Must precede even scratch creation.
  const scratch = mkdtempSync(join(parent, '.cook-lock-probe-'));
  const path = join(scratch, 'lock'); let a: number | undefined, b: number | undefined;
  try {
    a = openSync(path, F.O_RDWR | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
    b = openSync(path, F.O_RDWR | F.O_NOFOLLOW);
    if (helper(a) !== 0 || helper(b) !== 75) fail('E_IO', 3);
    closeSync(a); a = undefined;
    if (helper(b) !== 0) fail('E_IO', 3);
  } catch (e) { throw ioError(e); }
  finally { if (a !== undefined) closeSync(a); if (b !== undefined) closeSync(b); if (exists(path)) unlinkSync(path); rmdirSync(scratch); }
}
export function operationLock(root: string, create = false): () => void {
  privateDir(root); privateDir(join(root, '.cook'));
  // Completion may run in a different runtime/process than preparation. Never
  // assume the earlier process's descriptor qualification carries across.
  preflight(root);
  const path = join(root, '.cook/operation.lock');
  if (!create) privateFile(path);
  const fd = openSync(path, F.O_RDWR | F.O_NOFOLLOW | (create ? F.O_CREAT | F.O_EXCL : 0), 0o600);
  try {
    privateFile(path);
    const s = fstatSync(fd), p = lstatSync(path);
    if (s.ino !== p.ino || s.dev !== p.dev) fail('E_PATH');
    const result = flock(fd);
    if (result === 75) fail('E_BUSY', 4);
    if (result !== 0) fail('E_IO', 3);
    if (create) { fsyncSync(fd); syncDir(dirname(path)); }
  } catch (e) { closeSync(fd); throw ioError(e); }
  return () => closeSync(fd);
}
/** Any control artifact prevents legacy fallback, including malformed entries. */
export function candidateArtifact(root: string): boolean {
  if (!exists(root)) return false;
  // Only candidate roots acquire the new no-symlink policy. Legacy recipe
  // symlinks and legacy installation layouts retain their prior behavior.
  let directory: boolean;
  try { directory = statSync(root).isDirectory(); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
  if (!directory) return false;
  if (exists(join(root, '.cook')) || exists(join(root, 'connectome.deployment.json')) || exists(join(root, 'data/seed.consumed'))) {
    noLinks(root); return true;
  }
  const script = join(root, 'run.sh');
  try {
    if (statSync(script).isFile() && readFileSync(script, 'utf8').includes('connectome.candidate-launcher/v1')) {
      noLinks(root); noLinks(script); return true;
    }
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return false;
}
export function guard(root: string): void { if (candidateArtifact(root)) fail('E_HELD', 4); }
/** Atomic .cook mkdir is preparation ownership, not an advisory-lock fallback.
 * A crashed reservation is never reclaimed. All actual writes hold flock. */
export function reserve(root: string): () => void {
  // An existing empty R may be a mountpoint on a different filesystem.
  if (exists(root)) { privateDir(root); admitFilesystem(root); if (readdirSync(root).length) fail('E_SCOPE'); }
  preflight(exists(root) ? root : dirname(root));
  if (!exists(root)) { mkdirSync(root, { mode: 0o700 }); syncDir(dirname(root)); }
  privateDir(root);
  if (readdirSync(root).length) fail('E_SCOPE');
  try { mkdirSync(join(root, '.cook'), { mode: 0o700 }); } catch { fail('E_BUSY', 4); }
  const release = operationLock(root, true);
  try {
    if (readdirSync(root).some(n => n !== '.cook')) fail('E_SCOPE');
    mkdirSync(join(root, 'data'), { mode: 0o700 }); syncDir(root);
  } catch (e) { release(); throw ioError(e); }
  return release;
}
export function fresh(root: string): void {
  privateDir(root); admitLocalFilesystem(root);
  const data = join(root, 'data');
  if (exists(join(data, 'seed.consumed'))) fail('E_SEED_EXISTS', 4);
  if (exists(data)) { privateDir(data); admitLocalFilesystem(data); if (readdirSync(data).length) fail('E_HISTORY_EXISTS', 4); }
  if (exists(join(root, '.cook/ingest.intent.json'))) fail('E_INGEST_PENDING', 4);
}
