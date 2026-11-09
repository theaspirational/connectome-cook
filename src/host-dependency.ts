/** Local host inputs: snapshot first, inspect without extraction, never execute. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, fsyncSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { provisionPrivateDirectory, resolvePrivateDirectoryPath } from './private-directory.js';
import { log } from './log.js';
import { PinnedCommands } from './pinned-commands.js';
import { assertCredentialFreeSourceUrl } from './source-url.js';

const MAX_ARCHIVE = 64 * 1024 * 1024, MAX_TAR = 128 * 1024 * 1024, MAX_JSON = 1024 * 1024, MAX_ENTRIES = 10000;
type Section = 'dependencies' | 'devDependencies' | 'optionalDependencies';
export interface LockedHostDependency {
  name: string; originalRange: string; version: string; sha256: string; size: number; snapshot: string;
  packageJsonDelta: {
    direct: { section: Section; name: string; before: string; after: string };
    override: { section: 'overrides' | 'resolutions'; name: string; before: null; after: string };
  };
}
export interface HostDependencyInput { name: string; path: string; sha256: string }
function refuse(code: string, detail = 'local host dependency refused', usageError = false): never {
  const usage = usageError || code === 'E_HOST_DEPENDENCY_OPTION' || code === 'E_HOST_DEPENDENCY_DUPLICATE';
  throw new Error(`${code}: ${detail}${usage ? '' : '; no registry fallback'}`);
}
function resolutionSection(pkg: Record<string, unknown>): 'overrides' | 'resolutions' {
  const fields = ['overrides', 'resolutions'].filter(key => Object.hasOwn(pkg, key));
  if (fields.length > 1) refuse('E_HOST_DEPENDENCY_POLICY_FIELDS', 'both overrides and resolutions are present; Bun cannot compose them');
  for (const key of fields) {
    const value = pkg[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('E_HOST_DEPENDENCY_RANGE', `${key} must be an object`);
    // Nested npm overrides can change Bun's lock format even when disjoint.
    // Refuse before materialization rather than reaching the lock backstop.
    if (key === 'overrides') for (const [name, entry] of Object.entries(value)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        refuse('E_HOST_DEPENDENCY_RANGE', `overrides[${JSON.stringify(name)}]: nested overrides are not supported together with host dependency pins`);
      }
    }
  }
  return fields[0] === 'resolutions' ? 'resolutions' : 'overrides';
}
/** Do not try to model installer precedence or selector dialects. Only literal
 * unrelated package names can be proven disjoint; complex selectors and $refs
 * conservatively refuse, even when they might not match a selected input. */
function assertDisjointPolicy(entries: Record<string, unknown>, section: string, selected: string[]): void {
  const visit = (object: Record<string, unknown>, path: string, depth: number): void => {
    if (depth > 64) refuse('E_HOST_DEPENDENCY_RANGE', `${path}: resolution policy nesting exceeds 64`);
    for (const [key, value] of Object.entries(object)) {
      const at = `${path}[${JSON.stringify(key)}]`;
      const literal = key !== '.' && key !== '..' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(key);
      if (selected.includes(key) || (!literal && !(key === '.' && depth > 0))) {
        refuse('E_HOST_DEPENDENCY_RANGE', `${at}: policy could address selected input (${selected.join(', ')}); cannot compose selectors`);
      }
      if (typeof value === 'string') {
        if (value.trimStart().startsWith('$')) refuse('E_HOST_DEPENDENCY_RANGE', `${at}: policy reference ${JSON.stringify(value)} could address a selected input`);
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        visit(value as Record<string, unknown>, at, depth + 1);
      } else {
        refuse('E_HOST_DEPENDENCY_RANGE', `${at}: unsupported resolution policy value`);
      }
    }
  };
  visit(entries, section, 0);
}
function checkHash(bytes: Buffer, expected: string, path: string): string {
  const observed = createHash('sha256').update(bytes).digest('hex');
  if (observed !== expected) refuse('E_HOST_DEPENDENCY_HASH', `${path}: expected ${expected}, observed ${observed}`);
  return observed;
}
/** Older cooks may have dropped the lock field while retaining our checkout edits. */
export function assertHostDependencyReinstall(installDir: string, records: LockedHostDependency[] | undefined, inputs: HostDependencyInput[], drop = false): boolean {
  if (drop && inputs.length) refuse('E_HOST_DEPENDENCY_OPTION', '--drop-host-dependencies cannot be combined with --host-dependency');
  const names = new Set((records ?? []).map(record => record.name));
  const manifest = join(installDir, 'app', 'package.json');
  let snapshotsMissing = false;
  if (lstatIfPresent(manifest)) {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('invalid manifest');
    }
    catch {
      if (drop) return true; // explicit recovery must rebuild an uninspectable checkout
      if (!names.size) {
        log.warn(`cannot inspect retained checkout ${manifest}; lock records no host dependency pins — keeping existing reinstall behavior`);
        return false;
      }
      refuse('E_HOST_DEPENDENCY_REINSTALL', `cannot inspect retained checkout ${manifest}; repeat --host-dependency or pass --drop-host-dependencies`);
    }
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'overrides', 'resolutions']) {
      const entries = pkg[section];
      if (entries && typeof entries === 'object') for (const [name, value] of Object.entries(entries)) {
        if (typeof value === 'string' && /^file:.*\/host-inputs\/[a-f0-9]{64}\.tgz$/.test(value)) {
          names.add(name);
          if (!lstatIfPresent(value.slice(5))) snapshotsMissing = true;
        }
      }
    }
  }
  const missing = [...names].filter(name => !inputs.some(input => input.name === name));
  if (!drop && missing.length) refuse('E_HOST_DEPENDENCY_REINSTALL',
    `${snapshotsMissing ? 'pinned checkout; snapshots missing; ' : ''}lock or checkout records host dependencies (${missing.join(', ')}); repeat --host-dependency for each or pass --drop-host-dependencies`);
  return names.size > 0;
}
function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
function storage(root: string, create: boolean): void {
  try { provisionPrivateDirectory(root, create, 'dependency'); }
  catch (error) { refuse('E_HOST_DEPENDENCY_STORAGE', `${root}: ${(error as Error).message}; requires Linux /proc, root/same-user-owned symlinks only, and an owned 0700 host-inputs directory`); }
}
function isTrustedDependency(pkg: { trustedDependencies?: unknown }, name: string): boolean {
  if (!Object.hasOwn(pkg, 'trustedDependencies')) return false;
  const trusted = pkg.trustedDependencies;
  if (!Array.isArray(trusted) || !trusted.every(value => typeof value === 'string')) refuse('E_HOST_DEPENDENCY_TRUSTED', `${name}: host trustedDependencies must be an array of strings`);
  return trusted.includes(name);
}
export function parseHostDependencies(raw: unknown): HostDependencyInput[] {
  if (raw === undefined) return [];
  const names = new Set<string>();
  return (Array.isArray(raw) ? raw : [raw]).map(value => {
    const m = typeof value === 'string' && /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)=(.+)#sha256=([a-fA-F0-9]{64})$/.exec(value);
    if (!m) refuse('E_HOST_DEPENDENCY_OPTION', `${JSON.stringify(value)}: expected <name>=<absolute path>#sha256=<64 hex>`);
    if (!isAbsolute(m[2]!)) refuse('E_HOST_DEPENDENCY_OPTION', `${JSON.stringify(value)}: path is not absolute`);
    if (/[\0\r\n]/.test(m[2]!)) refuse('E_HOST_DEPENDENCY_OPTION', `${JSON.stringify(value)}: path contains NUL or a newline`);
    if (names.has(m[1]!)) refuse('E_HOST_DEPENDENCY_DUPLICATE', `${JSON.stringify(value)}: duplicate name ${m[1]}`);
    names.add(m[1]!);
    return { name: m[1]!, path: m[2]!, sha256: m[3]!.toLowerCase() };
  });
}
/** Deliberately bounded ustar subset: regular files/directories only. Reject
 * extensions/links rather than disagreeing with the installer's path rules. */
export function archivePackage(bytes: Buffer): { name?: unknown; version?: unknown } {
  let observedMagic = 'unavailable', reason = 'malformed or unsupported ustar archive';
  try {
    const tar = gunzipSync(bytes, { maxOutputLength: MAX_TAR });
    let offset = 0, entries = 0, manifest: Buffer | undefined, ended = false, root: string | undefined;
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
      if (type === 120 || type === 103 || type === 76 || type === 75) {
        reason = 'pax/extended header entry is unsupported'; throw 0;
      }
      if (type !== 0 && type !== 48 && type !== 53) throw 0;
      const normalized = type === 53 && path.endsWith('/') ? path.slice(0, -1) : path;
      if (!normalized || normalized.includes('\\') || normalized.split('/').some(p => !p || p === '..' || p === '.') || paths.has(normalized)) throw 0;
      const parts = normalized.split('/');
      root ??= parts[0];
      if (parts[0] !== root || (parts.length === 1 && type !== 53)) {
        reason = 'all entries must share one top-level directory'; throw 0;
      }
      paths.add(normalized);
      const size = octal(h.subarray(124, 136));
      const next = offset + 512 + Math.ceil(size / 512) * 512;
      if (next > tar.length || (type === 53 && size !== 0)) throw 0;
      if (normalized === root + '/package.json') {
        if (type === 53 || size > MAX_JSON) throw 0;
        manifest = tar.subarray(offset + 512, offset + 512 + size);
      }
      offset = next;
    }
    if (!ended || !manifest) throw 0;
    const pkg = JSON.parse(manifest.toString('utf8'));
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw 0;
    return pkg;
  } catch { throw new Error(`E_HOST_DEPENDENCY_ARCHIVE: ${reason}; observed magic=${observedMagic}; no registry fallback`); }
}
function readSnapshot(fd: number): Buffer {
  const size = fstatSync(fd).size;
  if (size > MAX_ARCHIVE) refuse('E_HOST_DEPENDENCY_FILE', `size ${size}; maximum ${MAX_ARCHIVE} bytes`);
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (!count) refuse('E_HOST_DEPENDENCY_FILE');
    offset += count;
  }
  return bytes;
}
function snapshot(source: string, dest: string, onCreated?: () => void): Buffer {
  let input: number | undefined, output: number | undefined;
  try {
    input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(input);
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size > MAX_ARCHIVE) throw new Error(`size ${st.size}; maximum ${MAX_ARCHIVE} bytes`);
    output = openSync(dest, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    onCreated?.();
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0, count: number;
    while ((count = readSync(input, chunk, 0, chunk.length, null))) {
      if ((total += count) > MAX_ARCHIVE) throw new Error(`maximum ${MAX_ARCHIVE} bytes exceeded during copy`);
      let written = 0;
      while (written < count) written += writeSync(output, chunk, written, count - written);
    }
    fchmodSync(output, 0o400);
    fsyncSync(output);
    // Read/hash ONLY the owned copy, never the source path.
    return readSnapshot(output);
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    return refuse('E_HOST_DEPENDENCY_FILE', `${source} → ${dest}: ${e.code ?? e.message}`);
  }
  finally { if (input !== undefined) closeSync(input); if (output !== undefined) closeSync(output); }
}
export async function preflightHostDependencies(url: string, ref: string, inputs: HostDependencyInput[], installDir: string, onStaged?: (cleanup: () => void) => void, commands = new PinnedCommands()): Promise<{ installDir: string; commit: string; checkout: string; records: LockedHostDependency[]; materialize: () => void; cleanup: () => void; discardNew: () => void }> {
  const { satisfies, valid, validRange } = await import('semver');
  assertCredentialFreeSourceUrl(url);
  if (/^[0-9a-f]{4,39}$/i.test(ref)) refuse('E_HOST_DEPENDENCY_SOURCE',
    `'${ref}' looks like an abbreviated commit ID; --host-dependency needs the full 40-hex ID (git rev-parse ${ref}); no output written`, true);
  try { installDir = resolvePrivateDirectoryPath(installDir); }
  catch (error) { refuse('E_HOST_DEPENDENCY_STORAGE', `${installDir}: ${(error as Error).message}`); }
  const inputRoot = join(installDir, 'host-inputs');
  storage(inputRoot, false); // read-only validation before preview or output mutation
  const root = mkdtempSync(join(tmpdir(), 'cook-host-dependency-')); // owned 0700; pre-mutation staging only
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  onStaged?.(cleanup);
  try {
    const artifacts = inputs.map((input, i) => {
      const path = join(root, `${i}.tgz`), bytes = snapshot(input.path, path);
      const sha256 = checkHash(bytes, input.sha256, `${input.name} (${input.path})`);
      let pkg: ReturnType<typeof archivePackage>;
      try { pkg = archivePackage(bytes); }
      catch (error) { throw new Error((error as Error).message.replace(': ', `: ${input.name} (${input.path}): `)); }
      if (pkg.name !== input.name) refuse('E_HOST_DEPENDENCY_NAME', `${input.path}: expected name ${input.name}, observed ${JSON.stringify(pkg.name)}`);
      return { input, path, size: bytes.length, sha256, pkg };
    });
    const git = (args: string[]) => commands.run('git', args, root);
    let commit: string, host: Partial<Record<Section | 'overrides' | 'resolutions', Record<string, unknown>>> & { trustedDependencies?: unknown };
    const checkout = join(root, 'source');
    let operation = 'init';
    try {
      await git(['init', checkout]);
      const base = ['-C', checkout];
      // Git interprets local relative remotes against -C; clone uses process cwd.
      const remote = /^(?:[a-z][a-z0-9+.-]*:|[^/]+:)/i.test(url) ? url : resolve(url);
      await git([...base, 'remote', 'add', 'origin', remote]);
      operation = 'fetch';
      log.step(`fetching host ${log.dim(url)}@${ref} (full history and tags)`);
      await git([...base, 'fetch', '--tags', '--', 'origin', ref]);
      commit = await git([...base, 'rev-parse', 'FETCH_HEAD^{commit}']);
      operation = 'read package.json';
      host = JSON.parse(await git([...base, 'show', commit + ':package.json']));
      if (!host || typeof host !== 'object' || Array.isArray(host)) throw new Error('manifest must be an object');
    } catch (error) {
      // Never echo arbitrary Git/helper output: it can contain authentication material.
      const e = error as NodeJS.ErrnoException & { stderr?: Buffer; status?: number; signal?: string };
      const stderr = String(e.stderr ?? '');
      const cause = /couldn't find remote ref/.test(stderr) ? 'ref not found'
        : /does not appear to be a git repository|not a git repository|repository .* not found/i.test(stderr) ? 'repository inaccessible'
        : e.code ?? (e.signal ? 'terminated ' + e.signal : e.status !== undefined ? 'exit ' + e.status : 'invalid host manifest');
      return refuse('E_HOST_DEPENDENCY_SOURCE', `${url}@${ref}: ${operation}: ${cause}; inspect with git fetch -- <repository> <ref>`);
    }
    const policy = resolutionSection(host);
    assertDisjointPolicy(host[policy] ?? {}, policy, inputs.map(input => input.name));
    const records = artifacts.map(({ input, size, sha256, pkg }) => {
      const sections = (['dependencies', 'devDependencies', 'optionalDependencies'] as const).filter(s => host[s] && Object.hasOwn(host[s], input.name));
      if (isTrustedDependency(host, input.name)) refuse('E_HOST_DEPENDENCY_TRUSTED', `${input.name} (${input.path}): host explicitly trusts this dependency's lifecycle scripts`);
      if (!sections.length) refuse('E_HOST_DEPENDENCY_UNDECLARED', `${input.name}: no direct declaration in acquired host`);
      if (sections.length !== 1) refuse('E_HOST_DEPENDENCY_RANGE', `${input.name}: multiple direct declarations`);
      const section = sections[0]!, range = host[section]![input.name];
      if (typeof range !== 'string' || !range.trim() || !validRange(range)) refuse('E_HOST_DEPENDENCY_RANGE', `${input.name}: unsupported original range ${JSON.stringify(range)}`);
      if (typeof pkg.version !== 'string' || !valid(pkg.version) || !satisfies(pkg.version, range)) refuse('E_HOST_DEPENDENCY_VERSION', `${input.name} (${input.path}): observed version ${JSON.stringify(pkg.version)}; expected range ${range}`);
      const path = join(installDir, 'host-inputs', sha256 + '.tgz'), after = 'file:' + path;
      return { name: input.name, originalRange: range, version: pkg.version, sha256, size, snapshot: path,
        packageJsonDelta: { direct: { section, name: input.name, before: range, after },
          override: { section: policy, name: input.name, before: null, after } } };
    });
    const created = new Set<string>();
    const discardNew = () => { for (const path of created) rmSync(path, { force: true }); };
    const materialize = () => {
      storage(inputRoot, true);
      let activePath = inputRoot;
      try {
        for (let i = 0; i < records.length; i++) {
          const record = records[i]!;
          activePath = record.snapshot;
          let bytes: Buffer;
          if (lstatIfPresent(record.snapshot)) {
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
            bytes = snapshot(artifacts[i]!.path, record.snapshot, () => created.add(record.snapshot));
          }
          checkHash(bytes, record.sha256, record.snapshot);
        }
        const fd = openSync(inputRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { fsyncSync(fd); } finally { closeSync(fd); }
        for (const artifact of artifacts) rmSync(artifact.path); // retain only the acquired checkout until transfer
      } catch (err) {
        discardNew();
        if ((err as Error).message.startsWith('E_HOST_DEPENDENCY_')) throw err;
        refuse('E_HOST_DEPENDENCY_FILE', `${activePath}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
      }
    };
    return { installDir, commit, checkout, records, materialize, cleanup, discardNew };
  } catch (err) { cleanup(); throw err; }
}
/** The checkout is the exact preflight-validated commit; apply only its planned delta. */
export function applyHostDependencies(checkout: string, records: LockedHostDependency[]): void {
  const path = join(checkout, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  for (const { packageJsonDelta: { direct: d, override } } of records) {
    pkg[d.section][d.name] = d.after;
    pkg[override.section] ??= {};
    pkg[override.section][override.name] = override.after;
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
}
/** Backstop the installer's policy implementation: every lock copy of a selected
 * name must identify the validated archive and its bytes, not just its version.
 * No node_modules census, dependent range check or precedence-aware merging. */
export function verifyHostDependencyResolutions(checkout: string, records: LockedHostDependency[]): void {
  const path = join(checkout, 'bun.lock');
  const reject = (detail: string): never => refuse('E_HOST_DEPENDENCY_RESOLUTION', `${path}: ${detail}`);
  let packages: Record<string, unknown>;
  try {
    const lock = Bun.JSONC.parse(readFileSync(path, 'utf8'));
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)) throw 0;
    const { lockfileVersion, packages: entries } = lock as Record<string, unknown>;
    if ((lockfileVersion !== 1 && lockfileVersion !== 2) || !entries || typeof entries !== 'object' || Array.isArray(entries)) throw 0;
    packages = entries as Record<string, unknown>;
  } catch { return reject('cannot verify pinned inputs: missing, malformed or unsupported text lockfile (supported lockfileVersion: 1 or 2)'); }
  for (const record of records) {
    // The tarball's validated manifest version is bound by these exact bytes.
    const bytes = readFileSync(record.snapshot);
    checkHash(bytes, record.sha256, record.snapshot);
    const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
    if (!Object.hasOwn(packages, record.name)) reject(`${record.name}: pinned root resolution is missing`);
    for (const [key, entry] of Object.entries(packages)) {
      const identity = Array.isArray(entry) ? entry[0] : undefined;
      const segments = key.split('/');
      let lastName = '';
      for (let i = 0; i < segments.length; i++) {
        lastName = segments[i]!;
        if (lastName.startsWith('@') && i + 1 < segments.length) lastName += '/' + segments[++i];
      }
      if (key !== record.name && lastName !== record.name && !(typeof identity === 'string' && identity.startsWith(record.name + '@'))) continue;
      if (!Array.isArray(entry) || identity !== `${record.name}@${record.snapshot}` || entry.length !== 3 || entry[2] !== integrity) {
        reject(`${record.name}: resolution ${JSON.stringify(key)} is not pinned to ${record.snapshot} (version ${record.version}, sha256 ${record.sha256})`);
      }
    }
  }
}
