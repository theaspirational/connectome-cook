/** Local host inputs: snapshot first, inspect without extraction, never execute. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, existsSync, readdirSync, realpathSync, statSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { satisfies, valid, validRange } from 'semver';
import { gitEnvironment } from './process-env.js';
import { provisionPrivateDirectory } from './private-directory.js';
import { assertCredentialFreeSourceUrl } from './source-url.js';

const MAX_ARCHIVE = 64 * 1024 * 1024, MAX_TAR = 128 * 1024 * 1024, MAX_JSON = 1024 * 1024, MAX_ENTRIES = 10000;
type Section = 'dependencies' | 'devDependencies' | 'optionalDependencies';
export interface LockedHostDependency {
  name: string; originalRange: string; version: string; sha256: string; size: number; snapshot: string;
  packageJsonDelta: {
    direct: { section: Section; name: string; before: string; after: string };
    override: { section: 'overrides'; name: string; before: null; after: string };
  };
  installedCopies?: Array<{ path: string; version: string }>;
  duplicateCount?: number | null;
  censusStatus?: 'complete' | 'incomplete';
  censusSkippedEntries?: Array<{ path: string; reason: string }>;
}
export interface HostDependencyInput { name: string; path: string; sha256: string }
function refuse(code: string): never { throw new Error(`${code}: local host dependency refused; no registry fallback`); }
function isTrustedDependency(pkg: { trustedDependencies?: unknown }, name: string): boolean {
  if (!Object.hasOwn(pkg, 'trustedDependencies')) return false;
  const trusted = pkg.trustedDependencies;
  if (!Array.isArray(trusted) || !trusted.every(value => typeof value === 'string')) refuse('E_HOST_DEPENDENCY_TRUSTED');
  return trusted.includes(name);
}
export function parseHostDependencies(raw: unknown): HostDependencyInput[] {
  if (raw === undefined) return [];
  const names = new Set<string>();
  return (Array.isArray(raw) ? raw : [raw]).map(value => {
    const m = typeof value === 'string' && /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)=(.+)#sha256=([a-fA-F0-9]{64})$/.exec(value);
    if (!m || !isAbsolute(m[2]!) || /[\0\r\n]/.test(m[2]!)) refuse('E_HOST_DEPENDENCY_OPTION');
    if (names.has(m[1]!)) refuse('E_HOST_DEPENDENCY_DUPLICATE');
    names.add(m[1]!);
    return { name: m[1]!, path: m[2]!, sha256: m[3]!.toLowerCase() };
  });
}
/** Deliberately bounded ustar subset: regular files/directories only. Reject
 * extensions/links rather than disagreeing with the installer's path rules. */
export function archivePackage(bytes: Buffer): { name?: unknown; version?: unknown } {
  let observedMagic = 'unavailable';
  try {
    const tar = gunzipSync(bytes, { maxOutputLength: MAX_TAR });
    let offset = 0, entries = 0, manifest: Buffer | undefined, ended = false;
    const paths = new Set<string>();
    const field = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '');
    const octal = (b: Buffer) => {
      const s = b.toString('ascii').replace(/\0/g, '').trim();
      if (!/^[0-7]+$/.test(s)) throw 0;
      return parseInt(s, 8);
    };
    while (offset + 512 <= tar.length) {
      const h = tar.subarray(offset, offset + 512);
      if (h.every(b => b === 0)) {
        if (tar.length - offset < 1024 || !tar.subarray(offset).every(b => b === 0)) throw 0;
        ended = true; break;
      }
      observedMagic = JSON.stringify(h.subarray(257, 265).toString('latin1'));
      if (++entries > MAX_ENTRIES || field(h.subarray(257, 263)) !== 'ustar') throw 0;
      const checksum = h.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
      if (checksum !== octal(h.subarray(148, 156))) throw 0;
      const name = field(h.subarray(0, 100)), prefix = field(h.subarray(345, 500));
      const path = prefix ? prefix + '/' + name : name;
      const type = h[156];
      if (type !== 0 && type !== 48 && type !== 53) throw 0;
      const normalized = type === 53 && path.endsWith('/') ? path.slice(0, -1) : path;
      if (!normalized || normalized.includes('\\') || normalized.split('/').some(p => !p || p === '..' || p === '.') || paths.has(normalized)) throw 0;
      paths.add(normalized);
      const size = octal(h.subarray(124, 136));
      const next = offset + 512 + Math.ceil(size / 512) * 512;
      if (next > tar.length || (type === 53 && size !== 0)) throw 0;
      if (path === 'package/package.json') {
        if (type === 53 || size > MAX_JSON) throw 0;
        manifest = tar.subarray(offset + 512, offset + 512 + size);
      }
      offset = next;
    }
    if (!ended || !manifest) throw 0;
    const pkg = JSON.parse(manifest.toString('utf8'));
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw 0;
    return pkg;
  } catch { throw new Error(`E_HOST_DEPENDENCY_ARCHIVE: local host dependency refused; observed magic=${observedMagic}; no registry fallback`); }
}
function readSnapshot(fd: number): Buffer {
  const size = fstatSync(fd).size;
  if (size > MAX_ARCHIVE) refuse('E_HOST_DEPENDENCY_FILE');
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (!count) refuse('E_HOST_DEPENDENCY_FILE');
    offset += count;
  }
  return bytes;
}
function snapshot(source: string, dest: string): Buffer {
  let input: number | undefined, output: number | undefined;
  try {
    input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(input);
    if (!st.isFile() || st.size > MAX_ARCHIVE) throw 0;
    output = openSync(dest, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0, count: number;
    while ((count = readSync(input, chunk, 0, chunk.length, null))) {
      if ((total += count) > MAX_ARCHIVE) throw 0;
      let written = 0;
      while (written < count) written += writeSync(output, chunk, written, count - written);
    }
    fchmodSync(output, 0o400);
    // Read/hash ONLY the owned copy, never the source path.
    return readSnapshot(output);
  } catch { return refuse('E_HOST_DEPENDENCY_FILE'); }
  finally { if (input !== undefined) closeSync(input); if (output !== undefined) closeSync(output); }
}
export function preflightHostDependencies(url: string, ref: string, inputs: HostDependencyInput[], installDir: string): { commit: string; records: LockedHostDependency[]; materialize: () => void; cleanup: () => void; discardNew: () => void } {
  assertCredentialFreeSourceUrl(url);
  const root = mkdtempSync(join(tmpdir(), 'cook-host-dependency-')); // owned 0700; pre-mutation staging only
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    const artifacts = inputs.map((input, i) => {
      const path = join(root, `${i}.tgz`), bytes = snapshot(input.path, path);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== input.sha256) refuse('E_HOST_DEPENDENCY_HASH');
      const pkg = archivePackage(bytes);
      if (pkg.name !== input.name) refuse('E_HOST_DEPENDENCY_NAME');
      return { input, path, size: bytes.length, sha256, pkg };
    });
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, env: gitEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: MAX_JSON }).trim();
    let commit: string, host: Partial<Record<Section | 'overrides' | 'resolutions', Record<string, unknown>>> & { trustedDependencies?: unknown };
    try {
      git(['init', '--bare', 'source.git']);
      const base = ['--git-dir=source.git'];
      git([...base, 'fetch', '--depth=1', '--', url, ref]);
      commit = git([...base, 'rev-parse', 'FETCH_HEAD^{commit}']);
      host = JSON.parse(git([...base, 'show', commit + ':package.json']));
      if (!host || typeof host !== 'object') throw 0;
    } catch { return refuse('E_HOST_DEPENDENCY_SOURCE'); }
    const records = artifacts.map(({ input, size, sha256, pkg }) => {
      const sections = (['dependencies', 'devDependencies', 'optionalDependencies'] as const).filter(s => host[s] && Object.hasOwn(host[s], input.name));
      if (isTrustedDependency(host, input.name)) refuse('E_HOST_DEPENDENCY_TRUSTED');
      if (!sections.length) refuse('E_HOST_DEPENDENCY_UNDECLARED');
      if (sections.length !== 1 || Object.hasOwn(host.overrides ?? {}, input.name) || Object.hasOwn(host.resolutions ?? {}, input.name)) refuse('E_HOST_DEPENDENCY_RANGE');
      const section = sections[0]!, range = host[section]![input.name];
      if (typeof range !== 'string' || !range.trim() || !validRange(range)) refuse('E_HOST_DEPENDENCY_RANGE');
      if (typeof pkg.version !== 'string' || !valid(pkg.version) || !satisfies(pkg.version, range)) refuse('E_HOST_DEPENDENCY_VERSION');
      const path = join(installDir, 'host-inputs', sha256 + '.tgz'), after = 'file:' + path;
      return { name: input.name, originalRange: range, version: pkg.version, sha256, size, snapshot: path,
        packageJsonDelta: { direct: { section, name: input.name, before: range, after },
          override: { section: 'overrides' as const, name: input.name, before: null, after } } };
    });
    rmSync(join(root, 'source.git'), { recursive: true, force: true });
    const created = new Set<string>();
    const discardNew = () => { for (const path of created) rmSync(path, { force: true }); };
    const materialize = () => {
      provisionPrivateDirectory(join(installDir, 'host-inputs'));
      try {
        for (let i = 0; i < records.length; i++) {
          const record = records[i]!;
          let bytes: Buffer;
          if (existsSync(record.snapshot)) {
            const fd = openSync(record.snapshot, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              const st = fstatSync(fd);
              const rejectRetained = (reason: string): never => { throw new Error(`E_HOST_DEPENDENCY_FILE: retained input ${record.snapshot} rejected: ${reason}; no registry fallback`); };
              if (!st.isFile()) rejectRetained('not a regular file');
              if (st.uid !== process.geteuid?.()) rejectRetained('owner does not match effective user');
              if ((st.mode & 0o7777) !== 0o400) rejectRetained(`mode ${(st.mode & 0o7777).toString(8)}; expected 400`);
              if (st.size !== record.size || st.size > MAX_ARCHIVE) rejectRetained(`size ${st.size}; expected ${record.size} bytes (maximum ${MAX_ARCHIVE})`);
              bytes = readSnapshot(fd);
            } finally { closeSync(fd); }
          } else {
            created.add(record.snapshot);
            bytes = snapshot(artifacts[i]!.path, record.snapshot);
          }
          if (bytes.length !== record.size || createHash('sha256').update(bytes).digest('hex') !== record.sha256) refuse('E_HOST_DEPENDENCY_HASH');
        }
        cleanup(); // No successful checkout ever depends on staging tmp.
      } catch (err) { discardNew(); throw err; }
    };
    return { commit, records, materialize, cleanup, discardNew };
  } catch (err) { cleanup(); throw err; }
}
/** Called after pinned checkout and immediately before bun install. */
export function applyHostDependencies(checkout: string, records: LockedHostDependency[]): void {
  const path = join(checkout, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  for (const { packageJsonDelta: { direct: d, override } } of records) {
    if (pkg[d.section]?.[d.name] !== d.before) refuse('E_HOST_DEPENDENCY_SOURCE');
    if (isTrustedDependency(pkg, d.name)) refuse('E_HOST_DEPENDENCY_TRUSTED');
    if (Object.hasOwn(pkg.overrides ?? {}, d.name) || Object.hasOwn(pkg.resolutions ?? {}, d.name)) refuse('E_HOST_DEPENDENCY_SOURCE');
    pkg[d.section][d.name] = d.after;
    pkg.overrides ??= {};
    pkg.overrides[override.name] = override.after;
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
}

/** Census only, not a range/API compatibility validator. Follow the installed
 * node_modules package tree, including scoped/nested copies and package links. */
export function recordInstalledHostDependencies(checkout: string, records: LockedHostDependency[]): void {
  for (const record of records) { record.installedCopies = []; record.duplicateCount = 0; }
  const visited = new Set<string>(), skipped = new Map<string, string>();
  const walk = (modules: string) => {
    if (!existsSync(modules)) return;
    // The census is observational: filesystem/metadata failures must not turn
    // a successful build into install failure and cleanup of its checkout.
    try {
      const real = realpathSync(modules);
      if (visited.has(real)) return;
      visited.add(real);
      const packages: string[] = [];
      for (const name of readdirSync(modules).filter(n => !n.startsWith('.'))) {
        const path = join(modules, name);
        if (!name.startsWith('@')) { packages.push(path); continue; }
        try {
          if (!statSync(path).isDirectory()) { skipped.set(path, 'scope entry is not a directory'); continue; }
          packages.push(...readdirSync(path).map(child => join(path, child)));
        } catch { skipped.set(path, 'scope entry could not be scanned'); }
      }
      for (const path of packages) {
        const manifest = join(path, 'package.json');
        try {
          const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
          if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) { skipped.set(manifest, 'manifest is not a JSON object'); continue; }
          for (const record of records) if (pkg.name === record.name) {
            record.installedCopies!.push({ path, version: String(pkg.version) });
          }
        } catch { skipped.set(manifest, 'manifest is unreadable or unparsable'); continue; }
        walk(join(path, 'node_modules'));
      }
    } catch { skipped.set(modules, 'node_modules directory could not be scanned'); }
  };
  walk(join(checkout, 'node_modules'));
  for (const record of records) {
    record.installedCopies!.sort((a, b) => a.path.localeCompare(b.path));
    record.censusStatus = skipped.size ? 'incomplete' : 'complete';
    record.duplicateCount = skipped.size ? null : Math.max(0, record.installedCopies!.length - 1);
    record.censusSkippedEntries = [...skipped].sort(([a], [b]) => a.localeCompare(b)).map(([path, reason]) => ({ path, reason }));
  }
}
