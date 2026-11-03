import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { archivePackage, recordInstalledHostDependencies, type LockedHostDependency } from './host-dependency.js';

let dir: string, repo: string, out: string, recipe: string, archive: string, digest: string, shim: string;
const realBun = process.execPath;
let snapshots: Set<string>;
function tar(entries: Array<{ path: string; data?: string; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const { path, data = '', type = '0' } of entries) {
    const bytes = Buffer.from(data), h = Buffer.alloc(512);
    h.write(path, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136); h.fill(32, 148, 156); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
    h.write(h.reduce((sum, n) => sum + n, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
function pack(name = 'fixture-local-input', version = '1.2.3', extra: Record<string, unknown> = {}) {
  const bytes = gzipSync(tar([{ path: 'package/package.json', data: JSON.stringify({ name, version, ...extra }) }]));
  writeFileSync(archive, bytes); digest = createHash('sha256').update(bytes).digest('hex');
}
function git(args: string[]) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim(); }
function host(range: unknown = '^1.0.0', section = 'dependencies') {
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'synthetic-host', version: '1.0.0', [section]: { 'fixture-local-input': range } }));
  git(['add', 'package.json']); git(['commit', '--allow-empty', '-m', 'Synthetic host']);
}
function option(name = 'fixture-local-input', path = archive, hash = digest) { return `${name}=${path}#sha256=${hash}`; }
function install(extra: string[] = ['--host-dependency', option()]) {
  const result = spawnSync(realBun, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--ch-ref', 'main', '--no-prompts', '--yes', ...extra], {
    encoding: 'utf8', env: { ...process.env, TMPDIR: join(dir, 'staging'), PATH: shim + ':' + process.env.PATH },
  });
  if (result.status === 0 && existsSync(join(out, 'connectome.lock'))) {
    const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
    for (const d of lock.hostDependencies ?? []) snapshots.add(dirname(d.snapshot));
  }
  return result;
}
function refused(code: string, extra?: string[]) {
  const r = install(extra);
  expect(r.status).not.toBe(0); expect(r.stderr).toContain(code); expect(existsSync(out)).toBe(false);
}
beforeEach(() => {
  snapshots = new Set();
  dir = mkdtempSync(join(tmpdir(), 'cook-local-input-test-')); repo = join(dir, 'host'); mkdirSync(repo);
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.org']); host();
  out = join(dir, 'install'); recipe = join(dir, 'recipe.json'); archive = join(dir, 'input.tgz');
  writeFileSync(recipe, JSON.stringify({ name: 'Synthetic', agent: { systemPrompt: 'Test only' } }));
  mkdirSync(join(dir, 'staging'));
  shim = join(dir, 'bin'); mkdirSync(shim);
  // Production bun install path, forced offline for the test: no registry even on accidental fallback.
  writeFileSync(join(shim, 'bun'), `#!/bin/sh\nexec env BUN_INSTALL_CACHE_DIR='${join(dir, "cache")}' '${realBun}' "$@" --offline\n`); chmodSync(join(shim, 'bun'), 0o755);
  pack();
});
afterEach(() => {
  for (const path of snapshots) rmSync(path, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});
test('CLI installs the artifact version offline, previews and records direct/override deltas and pinned commit', () => {
  const commit = git(['rev-parse', 'HEAD']);
  const r = install(); if (r.status) console.error(r.stdout, r.stderr);
  expect(r.status).toBe(0);
  expect(JSON.parse(readFileSync(join(out, 'app/node_modules/fixture-local-input/package.json'), 'utf8')).version).toBe('1.2.3');
  const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
  const d = lock.hostDependencies[0];
  expect(lock.version).toBe(1); expect(lock.connectomeHost.commit).toBe(commit);
  expect(d).toEqual({ name: 'fixture-local-input', originalRange: '^1.0.0', version: '1.2.3', sha256: digest, size: statSync(archive).size, snapshot: d.snapshot,
    packageJsonDelta: { direct: { section: 'dependencies', name: 'fixture-local-input', before: '^1.0.0', after: 'file:' + d.snapshot }, override: { section: 'overrides', name: 'fixture-local-input', before: null, after: 'file:' + d.snapshot } },
    installedCopies: [{ path: join(out, 'app/node_modules/fixture-local-input'), version: '1.2.3' }], duplicateCount: 0 });
  expect(d.snapshot).toBe(join(out, 'host-inputs', digest + '.tgz'));
  expect(r.stdout).toContain(`REPLACE dependency fixture-local-input ^1.0.0 → file:${d.snapshot} (sha256 ${digest.slice(0, 12)}…) + same-name override`);
  expect(d.snapshot).not.toBe(archive); expect(statSync(d.snapshot).mode & 0o777).toBe(0o400);
  expect(statSync(dirname(d.snapshot)).mode & 0o777).toBe(0o700);
  const original = JSON.parse(git(['show', commit + ':package.json'])); original.dependencies['fixture-local-input'] = 'file:' + d.snapshot; original.overrides = { 'fixture-local-input': 'file:' + d.snapshot };
  expect(JSON.parse(readFileSync(join(out, 'app/package.json'), 'utf8'))).toEqual(original);
});
test('source replacement after validation cannot affect the actual offline install', () => {
  writeFileSync(join(shim, 'bun'), `#!/bin/sh\nprintf corrupted > '${archive}'\nexec env BUN_INSTALL_CACHE_DIR='${join(dir, "cache")}' '${realBun}' "$@" --offline\n`);
  const r = install(); expect(r.status).toBe(0);
  expect(readFileSync(archive, 'utf8')).toBe('corrupted');
  expect(JSON.parse(readFileSync(join(out, 'app/node_modules/fixture-local-input/package.json'), 'utf8')).version).toBe('1.2.3');
});
test('distinct repeatable names including scoped names install from snapshots', () => {
  const second = join(dir, 'second.tgz'); const bytes = gzipSync(tar([{ path: 'package/package.json', data: JSON.stringify({ name: '@fixture/second', version: '2.0.0' }) }]));
  writeFileSync(second, bytes);
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')); pkg.dependencies['@fixture/second'] = '^2';
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg)); git(['commit', '-am', 'Second input']);
  const r = install(['--host-dependency', option(), '--host-dependency', option('@fixture/second', second, createHash('sha256').update(bytes).digest('hex'))]);
  expect(r.status).toBe(0);
  expect(JSON.parse(readFileSync(join(out, 'app/node_modules/@fixture/second/package.json'), 'utf8')).version).toBe('2.0.0');
});
for (const range of ['workspace:*', 'git+https://example.invalid/x', 'file:/tmp/input', 'link:/tmp/input', 'npm:other@1', 'https://example.invalid/input.tgz', 'not-semver', '', null]) test(`refuses unsupported original range ${range} before output`, () => {
  host(range); refused('E_HOST_DEPENDENCY_RANGE');
});
for (const input of ['bad', 'fixture-local-input=relative.tgz#sha256=' + '0'.repeat(64), 'fixture-local-input=https://example.invalid/x#sha256=' + '0'.repeat(64), 'fixture-local-input=/tmp/x#sha256=no']) test(`refuses malformed option ${input} before output`, () => refused('E_HOST_DEPENDENCY_OPTION', ['--host-dependency', input]));
test('refuses duplicate names before output', () => refused('E_HOST_DEPENDENCY_DUPLICATE', ['--host-dependency', option(), '--host-dependency', option()]));
test('refuses missing local archive before output', () => refused('E_HOST_DEPENDENCY_FILE', ['--host-dependency', option('fixture-local-input', join(dir, 'missing'))]));
test('refuses symlink and nonregular archive before output', () => {
  const link = join(dir, 'link'); symlinkSync(archive, link);
  refused('E_HOST_DEPENDENCY_FILE', ['--host-dependency', option('fixture-local-input', link)]);
  refused('E_HOST_DEPENDENCY_FILE', ['--host-dependency', option('fixture-local-input', dir)]);
});
test('refuses oversized compressed input before output', () => { truncateSync(archive, 64 * 1024 * 1024 + 1); refused('E_HOST_DEPENDENCY_FILE'); });
test('refuses hash mismatch before output', () => refused('E_HOST_DEPENDENCY_HASH', ['--host-dependency', option('fixture-local-input', archive, '0'.repeat(64))]));
test('refuses artifact name mismatch before output', () => { pack('different'); refused('E_HOST_DEPENDENCY_NAME'); });
for (const version of ['2.0.0', 'invalid', '1.2.3-beta.1']) test(`refuses incompatible or invalid version ${version} before output`, () => { pack('fixture-local-input', version); refused('E_HOST_DEPENDENCY_VERSION'); });
test('refuses undeclared direct dependency before output', () => { host(undefined, 'unrelated'); refused('E_HOST_DEPENDENCY_UNDECLARED'); });
test('refuses inaccessible acquired host before output', () => { rmSync(repo, { recursive: true }); refused('E_HOST_DEPENDENCY_SOURCE'); });
test('refuses invalid gzip without executing artifact scripts or creating output', () => {
  writeFileSync(archive, 'not gzip'); digest = createHash('sha256').update(readFileSync(archive)).digest('hex'); refused('E_HOST_DEPENDENCY_ARCHIVE');
});
for (const [label, entries] of Object.entries({
  missing: [{ path: 'package/other.json' }],
  duplicate: [{ path: 'package/package.json', data: '{}' }, { path: 'package/package.json', data: '{}' }],
  symlink: [{ path: 'package/package.json', type: '2' }],
  traversal: [{ path: '../package/package.json' }],
  ambiguous: [{ path: 'package//package.json', data: '{}' }],
  extension: [{ path: 'package/package.json', type: 'x' }],
  json: [{ path: 'package/package.json', data: '{' }],
  size: [{ path: 'package/package.json', data: ' '.repeat(1024 * 1024 + 1) }],
  entries: Array.from({ length: 10001 }, (_, i) => ({ path: `package/f${i}` })),
})) test(`refuses bounded tar/JSON ${label} before output`, () => {
  const bytes = gzipSync(tar(entries)); writeFileSync(archive, bytes); digest = createHash('sha256').update(bytes).digest('hex'); refused('E_HOST_DEPENDENCY_ARCHIVE');
});
test('rejects checksum, truncated tar and decompression bound', () => {
  const bytes = tar([{ path: 'package/package.json', data: '{}' }]); bytes[0] = 65;
  for (const content of [bytes, Buffer.alloc(512), Buffer.alloc(128 * 1024 * 1024 + 1)]) expect(() => archivePackage(gzipSync(content))).toThrow('E_HOST_DEPENDENCY_ARCHIVE');
});
test('held preparation refuses the legacy option before reserving any output', () => {
  const r = install(['--host-dependency', option(), '--hold', '--agent-id', '01234567-89ab-cdef-0123-456789abcdef', '--lineage-id', 'abcdef01-2345-6789-abcd-ef0123456789', '--json']);
  expect(r.status).toBe(1); expect(JSON.parse(r.stdout).findings[0].code).toBe('E_USAGE'); expect(existsSync(out)).toBe(false);
});
test('existing held metadata refuses before opening the input', () => {
  mkdirSync(join(out, '.cook'), { recursive: true });
  const r = install(['--host-dependency', 'bad']); expect(r.status).not.toBe(0); expect(r.stderr).toContain('E_HELD');
  expect(existsSync(join(out, 'app'))).toBe(false);
});

test('reinstall with a different artifact rebuilds the host instead of keeping a stale lock match', () => {
  expect(install().status).toBe(0);
  pack('fixture-local-input', '1.4.0');
  expect(install().status).toBe(0);
  expect(JSON.parse(readFileSync(join(out, 'app/node_modules/fixture-local-input/package.json'), 'utf8')).version).toBe('1.4.0');
  expect(JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8')).hostDependencies[0].sha256).toBe(digest);
});
for (const section of ['devDependencies', 'optionalDependencies']) test(`supports an original direct ${section} entry`, () => {
  host('^1', section); expect(install().status).toBe(0);
  expect(JSON.parse(readFileSync(join(out, 'app/node_modules/fixture-local-input/package.json'), 'utf8')).version).toBe('1.2.3');
  expect(JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8')).hostDependencies[0].packageJsonDelta.direct.section).toBe(section);
});
test('mismatch never executes package lifecycle scripts', () => {
  const marker = join(dir, 'script-ran');
  pack('fixture-local-input', '2.0.0', { scripts: { preinstall: `touch ${marker}` } });
  refused('E_HOST_DEPENDENCY_VERSION'); expect(existsSync(marker)).toBe(false);
});
test('ambiguous sections and dependency overrides refuse rather than risk registry substitution', () => {
  for (const field of ['devDependencies', 'overrides', 'resolutions']) {
    host();
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    pkg[field] = { 'fixture-local-input': '^1' };
    writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg)); git(['commit', '-am', 'Ambiguous resolution']);
    refused('E_HOST_DEPENDENCY_RANGE');
  }
});
test('removing the option restores original checkout rather than reusing the package.json delta', () => {
  expect(install().status).toBe(0);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'synthetic-host', version: '1.0.0' })); git(['commit', '-am', 'No dependencies']);
  expect(install([]).status).toBe(0);
  expect(JSON.parse(readFileSync(join(out, 'app/package.json'), 'utf8')).dependencies).toBeUndefined();
  expect(JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8')).hostDependencies).toBeUndefined();
});

test('durable input survives staging deletion and reinstall with an empty Bun cache', () => {
  expect(install().status).toBe(0);
  const snapshot = join(out, 'host-inputs', digest + '.tgz');
  expect(readdirSync(join(dir, 'staging'))).toEqual([]);
  rmSync(join(dir, 'staging'), { recursive: true }); rmSync(archive);
  rmSync(join(out, 'app/node_modules'), { recursive: true });
  expect(existsSync(snapshot)).toBe(true);
  expect(readFileSync(join(out, 'app/bun.lock'), 'utf8')).toContain(snapshot);
  const result = spawnSync(realBun, ['install', '--offline'], { cwd: join(out, 'app'), env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(dir, 'fresh-cache') }, encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(JSON.parse(readFileSync(join(out, 'app/node_modules/fixture-local-input/package.json'), 'utf8')).version).toBe('1.2.3');
});
test('same-name transitive resolution uses the override artifact offline, and lock records the installed census', () => {
  const wrapper = join(dir, 'wrapper.tgz');
  writeFileSync(wrapper, gzipSync(tar([{ path: 'package/package.json', data: JSON.stringify({ name: 'synthetic-wrapper', version: '1.0.0', dependencies: { 'fixture-local-input': '^9.0.0' } }) }])));
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')); pkg.dependencies['synthetic-wrapper'] = 'file:' + wrapper;
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg)); git(['commit', '-am', 'Transitive same-name fixture']);
  expect(install().status).toBe(0);
  const fromNested = createRequire(join(out, 'app/node_modules/synthetic-wrapper/package.json'));
  const resolved = fromNested.resolve('fixture-local-input/package.json');
  expect(JSON.parse(readFileSync(resolved, 'utf8')).version).toBe('1.2.3');
  const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
  expect(lock.hostDependencies[0].installedCopies).toContainEqual({ path: dirname(resolved), version: '1.2.3' });
  expect(lock.hostDependencies[0].duplicateCount).toBe(0); // Bun hoists the identical override.
  expect(readFileSync(join(out, 'app/bun.lock'), 'utf8')).not.toContain('fixture-local-input@9.');
});
test('trusted dependency names refuse before output creation', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')); pkg.trustedDependencies = ['fixture-local-input'];
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg)); git(['commit', '-am', 'Trusted input']);
  refused('E_HOST_DEPENDENCY_TRUSTED');
});
for (const format of ['gnu', 'pax']) test(`real tar --format=${format} fixture refuses with observed magic before output`, () => {
  const source = join(dir, 'tar-source'); mkdirSync(join(source, 'package'), { recursive: true });
  writeFileSync(join(source, 'package/package.json'), JSON.stringify({ name: 'fixture-local-input', version: '1.2.3' }));
  execFileSync('tar', ['--format=' + format, '-czf', archive, '-C', source, 'package']);
  digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  refused('E_HOST_DEPENDENCY_ARCHIVE');
  const magic = format === 'gnu' ? 'ustar  \0' : 'ustar\0' + '00';
  expect(install().stderr).toContain('observed magic=' + JSON.stringify(magic));
});
test('superseded inputs are retained for operator-controlled rollback, including after removing the option', () => {
  expect(install().status).toBe(0); const old = join(out, 'host-inputs', digest + '.tgz');
  pack('fixture-local-input', '1.4.0'); expect(install().status).toBe(0);
  expect(existsSync(old)).toBe(true);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'synthetic-host' })); git(['commit', '-am', 'No inputs']);
  expect(install([]).status).toBe(0); expect(existsSync(old)).toBe(true);
});
test('post-install output failure removes the mutated checkout and only this attempts new snapshot', () => {
  expect(install().status).toBe(0); const old = join(out, 'host-inputs', digest + '.tgz');
  rmSync(join(out, 'run.sh')); mkdirSync(join(out, 'run.sh')); // Force a write failure after bun install.
  pack('fixture-local-input', '1.4.0'); const failed = join(out, 'host-inputs', digest + '.tgz');
  expect(install().status).toBe(3);
  expect(existsSync(join(out, 'app'))).toBe(false);
  expect(existsSync(old)).toBe(true); expect(existsSync(failed)).toBe(false);
  expect(readdirSync(join(dir, 'staging'))).toEqual([]);
});
test('declined confirm gate removes staging and creates no output', () => {
  const result = spawnSync(realBun, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--no-prompts', '--host-dependency', option()], { encoding: 'utf8', env: { ...process.env, TMPDIR: join(dir, 'staging') } });
  expect(result.status).toBe(1); expect(existsSync(out)).toBe(false);
  expect(readdirSync(join(dir, 'staging'))).toEqual([]);
});
test('split layout stores input with runtime code, not configuration or state', () => {
  const bun = join(shim, 'selected-bun'), node = join(shim, 'node');
  writeFileSync(bun, `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.4; else exec '${realBun}' "$@" --offline; fi\n`); chmodSync(bun, 0o755);
  writeFileSync(node, '#!/bin/sh\necho v22.23.3\n'); chmodSync(node, 0o755);
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')); pkg.engines = { bun: '^1.4', node: '^22' };
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg)); git(['commit', '-am', 'Engines']);
  const layout = { schema: 'connectome.host-layout/v1', runtime: out, config: join(dir, 'config'), state: join(dir, 'state'), workspace: join(dir, 'workspace'), credentials: join(dir, 'credentials'), connectorState: {} };
  const path = join(dir, 'layout.json'); writeFileSync(path, JSON.stringify(layout));
  expect(install(['--host-dependency', option(), '--bun-path', bun, '--node-path', node, '--layout', path]).status).toBe(0);
  expect(existsSync(join(out, 'host-inputs', digest + '.tgz'))).toBe(true);
  expect(existsSync(join(layout.config, 'host-inputs'))).toBe(false);
});

test('installed-copy census reports scoped and nested duplicates without validating their ranges', () => {
  const root = join(out, 'app'), name = '@fixture/pinned';
  const copies = [join(root, 'node_modules', name), join(root, 'node_modules/wrapper/node_modules', name)] as const;
  for (const [i, path] of copies.entries()) {
    mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: `${i + 1}.0.0` }));
  }
  writeFileSync(join(root, 'node_modules/wrapper/package.json'), JSON.stringify({ name: 'wrapper', version: '1.0.0' }));
  const records = [{ name }] as LockedHostDependency[];
  recordInstalledHostDependencies(root, records);
  expect(records[0]!.installedCopies).toEqual([{ path: copies[0], version: '1.0.0' }, { path: copies[1], version: '2.0.0' }]);
  expect(records[0]!.duplicateCount).toBe(1);
});
test('reused durable snapshots are rehashed before checkout mutation', () => {
  expect(install().status).toBe(0);
  const snapshot = join(out, 'host-inputs', digest + '.tgz');
  chmodSync(snapshot, 0o600); writeFileSync(snapshot, 'tampered'); chmodSync(snapshot, 0o400);
  const result = install(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('E_HOST_DEPENDENCY_HASH');
  expect(existsSync(snapshot)).toBe(true); // Existing rollback artifacts are not deleted.
  expect(existsSync(join(out, 'app/node_modules/fixture-local-input/package.json'))).toBe(true);
  expect(readdirSync(join(dir, 'staging'))).toEqual([]);
});

test('recipe writes cannot overlap durable host inputs', () => {
  writeFileSync(recipe, JSON.stringify({ name: 'Synthetic', agent: { systemPrompt: 'Test' }, containerTemplateFiles: [{ hostPath: 'collision', inContainer: '/host-inputs/collision', template: 'conflict' }] }));
  refused('E_HOST_DEPENDENCY_SOURCE');
  expect(readdirSync(join(dir, 'staging'))).toEqual([]);
});
