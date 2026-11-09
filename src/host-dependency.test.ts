import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Socket } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as fs from 'node:fs';
import { archivePackage, preflightHostDependencies, parseHostDependencies, verifyHostDependencyResolutions } from './host-dependency.js';

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
  const result = spawnSync(realBun, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, ...(extra.includes('--ch-ref') ? [] : ['--ch-ref', 'main']), '--no-prompts', '--yes', ...extra], {
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
    packageJsonDelta: { direct: { section: 'dependencies', name: 'fixture-local-input', before: '^1.0.0', after: 'file:' + d.snapshot }, override: { section: 'overrides', name: 'fixture-local-input', before: null, after: 'file:' + d.snapshot } } });
  expect(d.snapshot).toBe(join(out, 'host-inputs', digest + '.tgz'));
  expect(r.stdout).toContain(`REPLACE dependency fixture-local-input ^1.0.0 → file:${d.snapshot} (sha256 ${digest.slice(0, 12)}…) + same-name overrides`);
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
test('explicitly dropping inputs restores original checkout rather than reusing the package.json delta', () => {
  expect(install().status).toBe(0);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'synthetic-host', version: '1.0.0' })); git(['commit', '-am', 'No dependencies']);
  expect(install(['--drop-host-dependencies']).status).toBe(0);
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
test('same-name transitive resolution uses the override artifact offline, without recording an installed census', () => {
  const wrapper = join(dir, 'wrapper.tgz');
  writeFileSync(wrapper, gzipSync(tar([{ path: 'package/package.json', data: JSON.stringify({ name: 'synthetic-wrapper', version: '1.0.0', dependencies: { 'fixture-local-input': '^9.0.0' } }) }])));
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')); pkg.dependencies['synthetic-wrapper'] = 'file:' + wrapper;
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg)); git(['commit', '-am', 'Transitive same-name fixture']);
  expect(install().status).toBe(0);
  const fromNested = createRequire(join(out, 'app/node_modules/synthetic-wrapper/package.json'));
  const resolved = fromNested.resolve('fixture-local-input/package.json');
  expect(JSON.parse(readFileSync(resolved, 'utf8')).version).toBe('1.2.3');
  const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
  expect(lock.hostDependencies[0].installedCopies).toBeUndefined();
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
  expect(install(['--drop-host-dependencies']).status).toBe(0); expect(existsSync(old)).toBe(true);
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
test('reused durable snapshots are rehashed before checkout mutation', () => {
  expect(install().status).toBe(0);
  const snapshot = join(out, 'host-inputs', digest + '.tgz');
  chmodSync(snapshot, 0o600); writeFileSync(snapshot, Buffer.alloc(statSync(snapshot).size)); chmodSync(snapshot, 0o400);
  const result = install(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('E_HOST_DEPENDENCY_HASH');
  expect(existsSync(snapshot)).toBe(true); // Existing rollback artifacts are not deleted.
  expect(existsSync(join(out, 'app/node_modules/fixture-local-input/package.json'))).toBe(true);
  expect(readdirSync(join(dir, 'staging'))).toEqual([]);
});

test('recipe writes cannot overlap durable host inputs', () => {
  writeFileSync(recipe, JSON.stringify({ name: 'Synthetic', agent: { systemPrompt: 'Test' }, containerTemplateFiles: [{ hostPath: 'collision', inContainer: '/host-inputs/collision', template: 'conflict' }] }));
  refused('E_HOST_DEPENDENCY_OVERLAP');
  expect(readdirSync(join(dir, 'staging'))).toEqual([]);
});

for (const value of ['fixture-local-input', { 'fixture-local-input': true }, ['fixture-local-input', 123]]) test(`malformed trustedDependencies ${JSON.stringify(value)} refuses before output`, () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')); pkg.trustedDependencies = value;
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg)); git(['commit', '-am', 'Malformed trusted dependencies']);
  refused('E_HOST_DEPENDENCY_TRUSTED');
  expect(readdirSync(join(dir, 'staging'))).toEqual([]);
});
for (const reason of ['mode', 'size']) test(`retained snapshot ${reason} refusal identifies the path and reason without damaging the install`, () => {
  expect(install().status).toBe(0);
  const snapshot = join(out, 'host-inputs', digest + '.tgz');
  chmodSync(snapshot, 0o600);
  if (reason === 'size') { writeFileSync(snapshot, 'short'); chmodSync(snapshot, 0o400); }
  const result = install(); expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`E_HOST_DEPENDENCY_FILE: retained input ${snapshot} rejected: ${reason}`);
  expect(existsSync(join(out, 'app/node_modules/fixture-local-input/package.json'))).toBe(true);
  expect(existsSync(snapshot)).toBe(true);
});

// R1 regressions use only synthetic local repositories and offline Bun installs.
for (const policy of ['overrides', 'resolutions']) test(`R1-1 composes with existing flat ${policy} without disabling unrelated pins`, () => {
  const other = join(dir, 'other.tgz');
  writeFileSync(other, gzipSync(tar([{ path: 'package/package.json', data: JSON.stringify({ name: 'fixture-r', version: '2.0.0' }) }])));
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  pkg.dependencies['fixture-r'] = '^1';
  pkg[policy] = { 'fixture-r': 'file:' + other, '@scope/unrelated': '^1' };
  const wrapper = join(dir, 'wrapper.tgz');
  writeFileSync(wrapper, gzipSync(tar([{ path: 'package/package.json', data: JSON.stringify({ name: 'synthetic-wrapper', version: '1.0.0', dependencies: { 'fixture-local-input': '^9.0.0' } }) }])));
  pkg.dependencies['synthetic-wrapper'] = 'file:' + wrapper;
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg)); git(['commit', '-am', 'Existing flat policy']);
  const r = install(); expect(r.status).toBe(0);
  const installed = JSON.parse(readFileSync(join(out, 'app/package.json'), 'utf8'));
  const nested = createRequire(join(out, 'app/node_modules/synthetic-wrapper/package.json'));
  expect(JSON.parse(readFileSync(nested.resolve('fixture-local-input/package.json'), 'utf8')).version).toBe('1.2.3');
  expect(installed[policy === 'overrides' ? 'resolutions' : 'overrides']).toBeUndefined();
  expect(installed[policy]['@scope/unrelated']).toBe('^1');
  expect(installed[policy]['fixture-r']).toBe('file:' + other);
  expect(installed[policy]['fixture-local-input']).toBe('file:' + join(out, 'host-inputs', digest + '.tgz'));
  expect(JSON.parse(readFileSync(join(out, 'app/node_modules/fixture-r/package.json'), 'utf8')).version).toBe('2.0.0');
  expect(JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8')).hostDependencies[0].packageJsonDelta.override.section).toBe(policy);
});
for (const policy of ['overrides', 'resolutions']) test(`R2 refuses reviewer nested-wrapper ${policy} before output`, () => {
  const wrapper = join(dir, 'wrapper.tgz'), other = join(dir, 'other.tgz');
  writeFileSync(wrapper, gzipSync(tar([{ path: 'package/package.json', data: JSON.stringify({ name: 'synthetic-wrapper', version: '1.0.0', dependencies: { 'fixture-local-input': '^9' } }) }])));
  writeFileSync(other, gzipSync(tar([{ path: 'package/package.json', data: JSON.stringify({ name: 'fixture-local-input', version: '9.0.0' }) }])));
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  pkg.dependencies['synthetic-wrapper'] = 'file:' + wrapper;
  pkg[policy] = policy === 'overrides' ? { 'synthetic-wrapper': { 'fixture-local-input': 'file:' + other } } : { 'synthetic-wrapper/fixture-local-input': 'file:' + other };
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg)); git(['commit', '-am', 'Nested policy bypass']);
  const r = install();
  expect(r.status).not.toBe(0); expect(r.stderr).toContain('E_HOST_DEPENDENCY_RANGE');
  expect(r.stderr).toContain(policy); expect(r.stderr).toContain(policy === 'overrides' ? 'synthetic-wrapper' : 'fixture-local-input');
  expect(existsSync(out)).toBe(false);
});
for (const policy of ['overrides', 'resolutions']) for (const key of [
  'a/b/fixture-local-input', '**/fixture-local-input', 'fixture-local-input@^1',
  '@scope/wrapper/fixture-local-input', 'fixture-*/**', '*',
]) test(`R2 refuses ${policy} selector ${key} naming the policy key`, () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  pkg[policy] = { [key]: '^9' };
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg)); git(['commit', '-am', 'Qualified policy']);
  const r = install(); expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('E_HOST_DEPENDENCY_RANGE'); expect(r.stderr).toContain(policy);
  expect(r.stderr).toContain(key); expect(existsSync(out)).toBe(false);
});
for (const policy of ['overrides', 'resolutions']) for (const value of [
  { a: { b: { 'fixture-local-input': '^9' } } },
  { a: { 'fixture-local-input@^1': { '.': '^9' } } },
  { a: '$fixture-local-input' }, { a: { b: '$fixture-local-input' } },
  { 'fixture-local-input': { '.': '^9' } },
]) test(`R2 refuses ${policy} nested policy or reference ${JSON.stringify(value)}`, () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')); pkg[policy] = value;
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg)); git(['commit', '-am', 'Nested or reference policy']);
  const r = install(); expect(r.status).not.toBe(0); expect(r.stderr).toContain('E_HOST_DEPENDENCY_RANGE');
  expect(r.stderr).toContain(policy); expect(existsSync(out)).toBe(false);
});
for (const [key, value] of [
  ['a', { '.': '^1', b: '^2' }], // Reviewer's disjoint nested repro, after a flat entry.
  ['@scope/unrelated', {}],
  ['fixture-local-input', { '.': '^1' }],
] as const) test(`R3 refuses any nested override ${key} before install writes`, () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  pkg.overrides = { unrelated: '^1', [key]: value };
  const manifest = JSON.stringify(pkg);
  writeFileSync(join(repo, 'package.json'), manifest); git(['commit', '-am', 'Nested overrides']);
  const marker = join(dir, 'install-ran');
  writeFileSync(join(shim, 'bun'), `#!/bin/sh\ntouch '${marker}'\nexec env BUN_INSTALL_CACHE_DIR='${join(dir, 'cache')}' '${realBun}' "$@" --offline\n`);
  const r = install();
  expect(r.status).not.toBe(0); expect(r.stderr).toContain('E_HOST_DEPENDENCY_RANGE');
  expect(r.stderr).toContain(`overrides[${JSON.stringify(key)}]`);
  expect(r.stderr).toContain('nested overrides are not supported together with host dependency pins');
  expect(r.stderr).not.toContain('E_HOST_DEPENDENCY_RESOLUTION');
  expect(existsSync(marker)).toBe(false); expect(existsSync(out)).toBe(false);
  expect(readdirSync(join(dir, 'staging'))).toEqual([]);
  expect(readFileSync(join(repo, 'package.json'), 'utf8')).toBe(manifest);
});
for (const key of ['@fixture/second', 'wrapper/@fixture/second', '@fixture/second@^2', '**/@fixture/second']) test(`R2 refuses policy addressing scoped input ${key}`, () => {
  pack('@fixture/second', '2.0.0');
  const pkg = { name: 'synthetic-host', dependencies: { '@fixture/second': '^2' }, resolutions: { [key]: '^9' } };
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg)); git(['commit', '-am', 'Scoped input policy']);
  const r = install(['--host-dependency', option('@fixture/second')]);
  expect(r.status).not.toBe(0); expect(r.stderr).toContain('E_HOST_DEPENDENCY_RANGE');
  expect(r.stderr).toContain(key); expect(existsSync(out)).toBe(false);
});
for (const corruption of ['nested-version', 'nested-same-version-bytes', 'integrity', 'missing', 'format', 'format-v3']) test(`R2 lock backstop refuses ${corruption} after real offline install`, () => {
  const tamper = join(dir, 'tamper.ts');
  writeFileSync(tamper, `import { readFileSync, writeFileSync, rmSync } from 'node:fs';
const lock = Bun.JSONC.parse(readFileSync('bun.lock', 'utf8'));
const entry = lock.packages['fixture-local-input'];
if (${JSON.stringify(corruption)} === 'nested-version') lock.packages['synthetic-wrapper/fixture-local-input'] = ['fixture-local-input@9.0.0', '', {}, 'sha512-other'];
if (${JSON.stringify(corruption)} === 'nested-same-version-bytes') lock.packages['synthetic-wrapper/fixture-local-input'] = ['fixture-local-input@' + ${JSON.stringify(archive)}, {}, entry[2]];
if (${JSON.stringify(corruption)} === 'integrity') entry[2] = 'sha512-wrong';
if (${JSON.stringify(corruption)} === 'format') lock.lockfileVersion = 999;
if (${JSON.stringify(corruption)} === 'format-v3') lock.lockfileVersion = 3;
writeFileSync('bun.lock', JSON.stringify(lock));
if (${JSON.stringify(corruption)} === 'missing') rmSync('bun.lock');
`);
  writeFileSync(join(shim, 'bun'), `#!/bin/sh\nenv BUN_INSTALL_CACHE_DIR='${join(dir, 'cache')}' '${realBun}' "$@" --offline || exit $?\nexec '${realBun}' '${tamper}'\n`);
  const r = install(); expect(r.status).not.toBe(0); expect(r.stderr).toContain('E_HOST_DEPENDENCY_RESOLUTION');
  expect(r.stderr).toContain('bun.lock'); expect(existsSync(join(out, 'app'))).toBe(false);
  if (['missing', 'format', 'format-v3'].includes(corruption)) {
    expect(r.stderr).toContain('cannot verify pinned inputs: missing, malformed or unsupported text lockfile');
    expect(r.stderr).toContain('supported lockfileVersion: 1 or 2');
  } else {
    expect(r.stderr).toContain('fixture-local-input'); expect(r.stderr).toContain(digest);
  }
  expect(existsSync(join(out, 'connectome.lock'))).toBe(false);
  expect(existsSync(join(out, 'host-inputs', digest + '.tgz'))).toBe(false);
});
for (const fields of [
  { overrides: {}, resolutions: {} }, { resolutions: [] }, { overrides: 'bad' }, { resolutions: null },
]) test(`R1-1 refuses ambiguous or malformed resolution policy ${JSON.stringify(fields)}`, () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  Object.assign(pkg, fields); writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg)); git(['commit', '-am', 'Invalid policy']);
  refused(Object.hasOwn(fields, 'overrides') && Object.hasOwn(fields, 'resolutions') ? 'E_HOST_DEPENDENCY_POLICY_FIELDS' : 'E_HOST_DEPENDENCY_RANGE');
});
test('R1-2 plain reinstall refuses and preserves pinned checkout and lock', () => {
  expect(install().status).toBe(0);
  const before = readFileSync(join(out, 'connectome.lock'), 'utf8');
  const result = install([]);
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('E_HOST_DEPENDENCY_REINSTALL');
  expect(result.stderr).toContain('--drop-host-dependencies');
  expect(readFileSync(join(out, 'connectome.lock'), 'utf8')).toBe(before);
  expect(JSON.parse(readFileSync(join(out, 'app/node_modules/fixture-local-input/package.json'), 'utf8')).version).toBe('1.2.3');
});
test('R1-2 explicit drop rebuilds and removes even an unrecorded checkout pin', () => {
  expect(install().status).toBe(0);
  const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
  delete lock.hostDependencies; writeFileSync(join(out, 'connectome.lock'), JSON.stringify(lock));
  const refused = install([]); expect(refused.status).not.toBe(0); expect(refused.stderr).toContain('E_HOST_DEPENDENCY_REINSTALL');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'synthetic-host', version: '1.0.0' })); git(['commit', '-am', 'Unpinned host']);
  expect(install(['--drop-host-dependencies']).status).toBe(0);
  expect(JSON.parse(readFileSync(join(out, 'app/package.json'), 'utf8')).dependencies).toBeUndefined();
  expect(JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8')).hostDependencies).toBeUndefined();
  expect(existsSync(join(out, 'host-inputs', digest + '.tgz'))).toBe(true);
});
test('R1-2 refuses contradictory drop and pin flags before output', () => refused('E_HOST_DEPENDENCY_OPTION', ['--host-dependency', option(), '--drop-host-dependencies']));
test('R1-3 mixed top-level directories cannot shadow the validated package', () => {
  for (const extra of ['zzz/package.json', 'zzz/README.md']) {
    const bytes = gzipSync(tar([
      { path: 'package/package.json', data: JSON.stringify({ name: 'fixture-local-input', version: '1.2.3' }) },
      { path: extra, data: JSON.stringify({ name: 'fixture-local-input', version: '9.9.9' }) },
    ]));
    writeFileSync(archive, bytes); digest = createHash('sha256').update(bytes).digest('hex');
    refused('E_HOST_DEPENDENCY_ARCHIVE');
  }
});
for (const dangling of [true, false]) test(`R1-4 preserves pre-existing ${dangling ? 'dangling' : 'live'} snapshot symlink with typed refusal`, () => {
  mkdirSync(join(out, 'host-inputs'), { recursive: true, mode: 0o700 });
  const snapshot = join(out, 'host-inputs', digest + '.tgz');
  symlinkSync(dangling ? join(dir, 'missing') : archive, snapshot);
  const result = install();
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('E_HOST_DEPENDENCY_FILE');
  expect(result.stderr).toContain(snapshot);
  expect(lstatSync(snapshot).isSymbolicLink()).toBe(true);
  expect(readFileSync(archive)).toEqual(gzipSync(tar([{ path: 'package/package.json', data: JSON.stringify({ name: 'fixture-local-input', version: '1.2.3' }) }])));
});
test('R2-6 resolves same-user output links and previews the canonical path', () => {
  const actual = join(dir, 'actual'); mkdirSync(actual);
  const link = join(dir, 'linked'); symlinkSync(actual, link);
  out = join(link, 'new-install');
  const result = install();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`Host install plan → ${join(actual, 'new-install')}`);
  const record = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8')).hostDependencies[0];
  expect(record.snapshot).toBe(join(actual, 'new-install/host-inputs', digest + '.tgz'));
});
for (const owner of [0, 1003]) test(`R2-6 link owner ${owner} follows root/same-user trust policy`, async () => {
  const actual = join(dir, 'actual'); mkdirSync(actual);
  const link = join(dir, 'linked'); symlinkSync(actual, link);
  const original = fs.lstatSync;
  const spy = spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike) => {
    const stat = original(path);
    if (String(path) === link) stat.uid = owner;
    return stat;
  }) as typeof fs.lstatSync);
  let checked: Awaited<ReturnType<typeof preflightHostDependencies>> | undefined;
  try {
    const run = async () => { checked = await preflightHostDependencies(repo, 'main', parseHostDependencies(option()), join(link, 'install')); };
    if (owner === 0) await run();
    else { await expect(run()).rejects.toThrow('E_HOST_DEPENDENCY_STORAGE'); expect(existsSync(join(actual, 'install'))).toBe(false); }
  } finally { spy.mockRestore(); checked?.cleanup(); }
});
test('R1-5 rejects an unsafe existing input directory before preview', () => {
  mkdirSync(join(out, 'host-inputs'), { recursive: true, mode: 0o755 });
  const result = install(); expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('E_HOST_DEPENDENCY_STORAGE');
  expect(result.stdout).not.toContain('Host install plan');
  expect(existsSync(join(out, 'recipes'))).toBe(false);
});
test('R1-6 file failures identify input, path and safe cause', () => {
  for (const [path, reason] of [[join(dir, 'missing'), 'ENOENT'], [dir, 'not a regular file']] as const) {
    const r = install(['--host-dependency', option('fixture-local-input', path)]);
    expect(r.stderr).toContain('E_HOST_DEPENDENCY_FILE');
    expect(r.stderr).toContain(path); expect(r.stderr).toContain(reason);
  }
  truncateSync(archive, 64 * 1024 * 1024 + 1);
  expect(install().stderr).toContain('maximum 67108864');
});
test('R1-6 mismatches report expected and observed identity/range', () => {
  const r = install(['--host-dependency', option('fixture-local-input', archive, '0'.repeat(64))]);
  expect(r.stderr).toContain('expected ' + '0'.repeat(64)); expect(r.stderr).toContain('observed ' + digest);
  pack('fixture-local-input', '2.0.0');
  const version = install(); expect(version.stderr).toContain('2.0.0'); expect(version.stderr).toContain('^1.0.0');
});
test('R1-6 source failures distinguish missing ref from inaccessible repository without echoing helper output', () => {
  const missingRef = install(['--host-dependency', option(), '--ch-ref', 'typo-ref']);
  expect(missingRef.stderr).toContain('E_HOST_DEPENDENCY_SOURCE');
  expect(missingRef.stderr).toContain('typo-ref'); expect(missingRef.stderr).toContain('ref not found');
  rmSync(repo, { recursive: true });
  const missingRepo = install();
  expect(missingRepo.stderr).toContain(repo); expect(missingRepo.stderr).toContain('repository inaccessible');
});
test('R1-7 lock records policy inputs only, without a node_modules census', () => {
  expect(install().status).toBe(0);
  const record = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8')).hostDependencies[0];
  for (const field of ['installedCopies', 'duplicateCount', 'censusStatus', 'censusSkippedEntries']) expect(record[field]).toBeUndefined();
});
test('R1-9 reuses the acquired checkout instead of fetching the host twice', () => {
  const calls = join(dir, 'git-calls');
  writeFileSync(join(shim, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
  expect(install().status).toBe(0);
  const lines = readFileSync(calls, 'utf8').trim().split('\n');
  expect(lines.filter(line => /\bfetch\b/.test(line))).toHaveLength(1);
  expect(lines.filter(line => /\bclone\b/.test(line))).toHaveLength(0);
  expect(execFileSync('/usr/bin/git', ['remote', 'get-url', 'origin'], { cwd: join(out, 'app'), encoding: 'utf8' }).trim()).toBe(repo);
});
test('R1-nit extended headers report the unsupported entry, not just valid ustar magic', () => {
  expect(() => archivePackage(gzipSync(tar([{ path: 'package/PaxHeader', type: 'x' }])))).toThrow('pax/extended header entry');
});

test('R1-5 unsupported platforms refuse read-only before staging or output', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    await expect(preflightHostDependencies(repo, 'main', parseHostDependencies(option()), out)).rejects.toThrow('E_HOST_DEPENDENCY_STORAGE');
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(join(dir, 'staging'))).toEqual([]);
  } finally { Object.defineProperty(process, 'platform', platform); }
});
test('R1-nit durability syncs the snapshot before its containing directory', async () => {
  const synced: string[] = [], original = fs.fsyncSync;
  const spy = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    synced.push(fs.readlinkSync('/proc/self/fd/' + fd)); original(fd);
  });
  let checked: Awaited<ReturnType<typeof preflightHostDependencies>> | undefined;
  try {
    checked = await preflightHostDependencies(repo, 'main', parseHostDependencies(option()), out);
    checked.materialize();
    const snapshot = join(out, 'host-inputs', digest + '.tgz');
    expect(synced).toContain(snapshot);
    expect(synced.lastIndexOf(join(out, 'host-inputs'))).toBeGreaterThan(synced.indexOf(snapshot));
  } finally { spy.mockRestore(); checked?.cleanup(); checked?.discardNew(); }
});
test('R1-nit durability failure refuses and discards only the new snapshot', async () => {
  const checked = await preflightHostDependencies(repo, 'main', parseHostDependencies(option()), out);
  const snapshot = join(out, 'host-inputs', digest + '.tgz'), original = fs.fsyncSync;
  const spy = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (fs.readlinkSync('/proc/self/fd/' + fd) === snapshot) throw new Error('fixture fsync failure');
    original(fd);
  });
  try {
    expect(() => checked.materialize()).toThrow('E_HOST_DEPENDENCY_FILE');
    expect(existsSync(snapshot)).toBe(false);
  } finally { spy.mockRestore(); checked.cleanup(); checked.discardNew(); }
});
test('R1-4 an exclusive-create race never claims or deletes another snapshot', async () => {
  const checked = await preflightHostDependencies(repo, 'main', parseHostDependencies(option()), out);
  const snapshot = join(out, 'host-inputs', digest + '.tgz'), original = fs.openSync;
  let injected = false;
  const spy = spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    if (!injected && path === snapshot && typeof flags === 'number' && (flags & fs.constants.O_CREAT)) {
      injected = true;
      fs.writeFileSync(snapshot, 'race winner', { mode: 0o400 });
    }
    return original(path, flags, mode);
  });
  try {
    expect(() => checked.materialize()).toThrow('E_HOST_DEPENDENCY_FILE');
    expect(readFileSync(snapshot, 'utf8')).toBe('race winner');
  } finally { spy.mockRestore(); checked.cleanup(); checked.discardNew(); }
});

// Maintainer round 2: history, scope boundaries, retained pins and usage errors.
test('R2-1 pinned checkout retains full history and reachable tags in one fetch', () => {
  const ancestor = git(['rev-parse', 'HEAD']);
  git(['tag', '-a', 'v1.0.0', '-m', 'Release']);
  for (let i = 0; i < 3; i++) git(['commit', '--allow-empty', '-m', `History ${i}`]);
  expect(install().status).toBe(0);
  const appGit = (...args: string[]) => execFileSync('git', args, { cwd: join(out, 'app'), encoding: 'utf8' }).trim();
  expect(appGit('rev-parse', '--is-shallow-repository')).toBe('false');
  expect(appGit('describe', '--tags')).toMatch(/^v1\.0\.0-3-g/);
  expect(appGit('merge-base', ancestor, 'HEAD')).toBe(ancestor);
  expect(appGit('merge-base', '--is-ancestor', ancestor, 'HEAD')).toBe('');
});
test('R2-2 abbreviated host refs refuse before reading inputs or creating staging', () => {
  const abbrev = git(['rev-parse', '--short=8', 'HEAD']);
  rmSync(archive);
  const r = install(['--host-dependency', option(), '--ch-ref', abbrev]);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain(`'${abbrev}' looks like an abbreviated commit ID`);
  expect(r.stderr).toContain(`needs the full 40-hex ID (git rev-parse ${abbrev}); no output written`);
  expect(existsSync(out)).toBe(false); expect(readdirSync(join(dir, 'staging'))).toEqual([]);
});
for (const [name, key] of [['semver', '@types/semver'], ['ws', 'ws/@types/ws']]) test(`R2-3 verifier ignores scoped lookalike ${key} for ${name}`, () => {
  pack(name);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'synthetic-host', dependencies: { [name!]: '^1' } }));
  git(['commit', '-am', 'Unscoped pin']);
  expect(install(['--host-dependency', option(name!)]).status).toBe(0);
  const path = join(out, 'app/bun.lock'), lock = Bun.JSONC.parse(readFileSync(path, 'utf8')) as any;
  lock.packages[key!] = [`@types/${name}@1.0.0`, '', {}, 'sha512-unrelated'];
  writeFileSync(path, JSON.stringify(lock));
  const records = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8')).hostDependencies;
  expect(() => verifyHostDependencyResolutions(join(out, 'app'), records)).not.toThrow();
  for (const nested of [`node_modules/${name}`, `parent/${name}`, `@scope/parent/${name}`]) {
    lock.packages[nested] = [`${name}@9.0.0`, '', {}, 'sha512-other'];
    writeFileSync(path, JSON.stringify(lock));
    expect(() => verifyHostDependencyResolutions(join(out, 'app'), records)).toThrow('E_HOST_DEPENDENCY_RESOLUTION');
    delete lock.packages[nested];
  }
});
for (const [value, reason] of [
  ['bad', 'expected <name>=<absolute path>#sha256=<64 hex>'],
  ['fixture-local-input=relative.tgz#sha256=' + '0'.repeat(64), 'path is not absolute'],
  ['fixture-local-input=/tmp/x#sha256=123', 'expected <name>=<absolute path>#sha256=<64 hex>'],
]) test(`R2-4 option refusal identifies value and reason: ${value}`, () => {
  const r = install(['--host-dependency', value!]);
  expect(r.status).not.toBe(0); expect(r.stderr).toContain(value!); expect(r.stderr).toContain(reason!);
});
test('R2-4 duplicate refusal names the duplicate', () => {
  expect(install(['--host-dependency', option(), '--host-dependency', option()]).stderr).toContain('duplicate name fixture-local-input');
});
test('R2-5 missing snapshots and lost lock records cannot hide retained checkout pins', () => {
  expect(install().status).toBe(0);
  const lockPath = join(out, 'connectome.lock'), lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  delete lock.hostDependencies; writeFileSync(lockPath, JSON.stringify(lock));
  rmSync(join(out, 'host-inputs'), { recursive: true });
  const before = readFileSync(lockPath, 'utf8');
  const result = install([]);
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('E_HOST_DEPENDENCY_REINSTALL');
  expect(result.stderr).toContain('pinned checkout; snapshots missing');
  expect(readFileSync(lockPath, 'utf8')).toBe(before);
});
for (const command of ['build', 'run', 'check']) test(`R2-nit --host-dependency refuses outside install (${command})`, () => {
  const r = spawnSync(realBun, [resolve('bin/cook'), command, recipe, '--host-dependency', option()], { encoding: 'utf8' });
  expect(r.status).not.toBe(0); expect(r.stderr).toContain('--host-dependency is only supported by install');
});
test('R2-nit dropping absent pins keeps an unchanged host', () => {
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'synthetic-host' })); git(['commit', '-am', 'Flagless host']);
  expect(install([]).status).toBe(0);
  writeFileSync(join(out, 'app', 'kept'), 'keep');
  const r = install(['--drop-host-dependencies']);
  expect(r.status).toBe(0); expect(r.stdout).toContain('unchanged'); expect(existsSync(join(out, 'app', 'kept'))).toBe(true);
});
test('R2-nit only host-inputs gets private directory creation mode', () => {
  const mask = process.umask(0o022);
  try {
    out = join(dir, 'new-parent/install'); expect(install().status).toBe(0);
    expect(statSync(dirname(out)).mode & 0o777).toBe(0o755);
    expect(statSync(out).mode & 0o777).toBe(0o755);
    expect(statSync(join(out, 'host-inputs')).mode & 0o777).toBe(0o700);
  } finally { process.umask(mask); }
});
for (const phase of ['fetch', 'build']) for (const signal of ['SIGINT', 'SIGTERM'] as const) test(`R2-nit signal cleanup re-raises ${signal} during ${phase}`, async () => {
  const marker = join(dir, 'waiting');
  if (phase === 'build') writeFileSync(join(shim, 'bun'), `#!/bin/sh\ntouch '${marker}'\nexec sleep 30\n`);
  else writeFileSync(join(shim, 'git'), `#!/bin/sh\ncase " $* " in *' fetch '*) touch '${marker}'; exec sleep 30;; esac\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
  const child = spawn(realBun, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--no-prompts', '--yes', '--host-dependency', option()], {
    detached: true, stdio: 'ignore', env: { ...process.env, TMPDIR: join(dir, 'staging'), PATH: shim + ':' + process.env.PATH },
  });
  const exited = new Promise<string | null>(resolve => child.on('exit', (_code, signal) => resolve(signal)));
  try {
    const deadline = Date.now() + 4000;
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(marker)).toBe(true);
    expect(readdirSync(join(dir, 'staging')).length).toBeGreaterThan(0);
    process.kill(-child.pid!, signal);
    expect(await exited).toBe(signal);
    expect(readdirSync(join(dir, 'staging'))).toEqual([]);
    expect(existsSync(join(out, 'app'))).toBe(false);
    expect(existsSync(join(out, 'host-inputs', digest + '.tgz'))).toBe(false);
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    await exited;
  }
}, 10000);

test('R2-1/R2-2 full non-tip SHA still installs the selected commit with history', () => {
  git(['tag', '-a', 'v1.0.0', '-m', 'Release']);
  git(['commit', '--allow-empty', '-m', 'Selected']);
  const selected = git(['rev-parse', 'HEAD']);
  git(['commit', '--allow-empty', '-m', 'Later tip']);
  expect(install(['--host-dependency', option(), '--ch-ref', selected]).status).toBe(0);
  const appGit = (...args: string[]) => execFileSync('git', args, { cwd: join(out, 'app'), encoding: 'utf8' }).trim();
  expect(appGit('rev-parse', 'HEAD')).toBe(selected);
  expect(appGit('rev-parse', '--is-shallow-repository')).toBe('false');
  expect(appGit('describe', '--tags')).toMatch(/^v1\.0\.0-1-g/);
});
test('R2-6 refuses another-user link reached inside a trusted link target', async () => {
  const actual = join(dir, 'actual'); mkdirSync(actual);
  const untrusted = join(dir, 'other-link'); symlinkSync(actual, untrusted);
  const trusted = join(dir, 'trusted-link'); symlinkSync('other-link/../actual', trusted);
  const original = fs.lstatSync;
  const spy = spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike) => {
    const stat = original(path);
    if (String(path) === untrusted) stat.uid = 1003;
    return stat;
  }) as typeof fs.lstatSync);
  try {
    await expect(preflightHostDependencies(repo, 'main', parseHostDependencies(option()), join(trusted, 'install'))).rejects.toThrow('E_HOST_DEPENDENCY_STORAGE');
    expect(existsSync(join(actual, 'install'))).toBe(false);
  } finally { spy.mockRestore(); }
});


test('R3-P2 pinned build retains its controlling terminal under a PTY', () => {
  writeFileSync(join(shim, 'bun'), `#!/bin/sh\nexec 3<>/dev/tty || exit 3\nprintf 'build has controlling tty\\n' >&3\nexec env BUN_INSTALL_CACHE_DIR='${join(dir, "cache")}' '${realBun}' "$@" --offline\n`);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const args = [realBun, resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo,
    '--ch-ref', 'main', '--no-prompts', '--yes', '--host-dependency', option()];
  const result = spawnSync('script', ['-q', '-e', '-c', args.map(quote).join(' '), '/dev/null'], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, TMPDIR: join(dir, 'staging'), PATH: shim + ':' + process.env.PATH },
  });
  expect(result.stdout + result.stderr).toContain('build has controlling tty');
  expect(result.status).toBe(0);
  const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
  for (const dependency of lock.hostDependencies) snapshots.add(dirname(dependency.snapshot));
});

// Maintainer round 3: signals must reach cook alone, not its process group.
for (const phase of ['fetch', 'build', 'stubborn build']) for (const signal of ['SIGINT', 'SIGTERM'] as const) test(`R3-1 PID-only ${signal} cancels hanging ${phase}`, async () => {
  const marker = join(dir, 'child-pid');
  const sockets = new Set<Socket>();
  let accepted = false;
  const server = createServer(socket => { accepted = true; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  if (phase !== 'fetch') writeFileSync(join(shim, 'bun'), `#!/bin/sh\n${phase === 'stubborn build' ? "trap '' INT TERM\n" : ''}echo $$ > '${marker}'\nexec sleep 30\n`);
  else writeFileSync(join(shim, 'git'), `#!/bin/sh\ncase " $* " in *' fetch '*) echo $$ > '${marker}';; esac\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
  const child = spawn(realBun, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', phase === 'fetch' ? `git://127.0.0.1:${port}/host` : repo, '--no-prompts', '--yes', '--host-dependency', option()], {
    detached: true, stdio: 'ignore', env: { ...process.env, TMPDIR: join(dir, 'staging'), PATH: shim + ':' + process.env.PATH },
  });
  const exited = new Promise<string | null>(resolve => child.on('exit', (_code, signal) => resolve(signal)));
  try {
    const deadline = Date.now() + 4000;
    while ((!existsSync(marker) || (phase === 'fetch' && !accepted)) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(marker)).toBe(true);
    if (phase === 'fetch') expect(accepted).toBe(true);
    expect(readdirSync(join(dir, 'staging')).length).toBeGreaterThan(0);
    const signalledAt = Date.now();
    child.kill(signal); // Deliberately NOT process.kill(-child.pid, signal).
    expect(await Promise.race([exited, Bun.sleep(2500).then(() => 'timed out')])).toBe(signal);
    if (phase === 'stubborn build') expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(900);
    const pid = Number(readFileSync(marker, 'utf8'));
    const deadlineForReap = Date.now() + 500;
    const running = () => {
      try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]![0] !== 'Z'; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    };
    while (running() && Date.now() < deadlineForReap) await Bun.sleep(10);
    expect(running()).toBe(false);
    expect(readdirSync(join(dir, 'staging'))).toEqual([]);
    expect(existsSync(join(out, 'app'))).toBe(false);
    expect(existsSync(join(out, 'host-inputs', digest + '.tgz'))).toBe(false);
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    if (existsSync(marker)) { try { process.kill(Number(readFileSync(marker, 'utf8')), 'SIGKILL'); } catch { /* already gone */ } }
    await exited;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10000);

for (const pins of [false, true]) test(`R3-2 conflict-marker manifest with lock pins=${pins}`, () => {
  if (!pins) {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'synthetic-host' })); git(['commit', '-am', 'Flagless host']);
  }
  expect(install(pins ? undefined : []).status).toBe(0);
  const manifest = join(out, 'app/package.json');
  const broken = '<<<<<<< HEAD\n{"name":"left"}\n=======\n{"name":"right"}\n>>>>>>> topic\n';
  writeFileSync(manifest, broken);
  const r = install([]);
  if (pins) {
    expect(r.status).not.toBe(0); expect(r.stderr).toContain('E_HOST_DEPENDENCY_REINSTALL');
  } else {
    expect(r.status).toBe(0); expect(r.stdout).toContain('unchanged connectome-host — kept');
    expect(r.stderr).toContain('cannot inspect retained checkout');
    expect(r.stderr).not.toContain('E_HOST_DEPENDENCY');
  }
  expect(readFileSync(manifest, 'utf8')).toBe(broken);
});

test('R3-3 relative local --ch-repo resolves against process cwd', () => {
  const r = spawnSync(realBun, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', 'host', '--no-prompts', '--yes', '--host-dependency', option()], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, TMPDIR: join(dir, 'staging'), PATH: shim + ':' + process.env.PATH },
  });
  expect(r.status).toBe(0);
  expect(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: join(out, 'app'), encoding: 'utf8' }).trim()).toBe(repo);
});


for (const length of [4, 5, 6, 7, 39]) test(`R3-5/R3-10 ${length}-hex host ref refuses as usage without fallback wording`, () => {
  const ref = 'a'.repeat(length);
  rmSync(archive);
  const r = install(['--host-dependency', option(), '--ch-ref', ref]);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain(`'${ref}' looks like an abbreviated commit ID`);
  expect(r.stderr).not.toContain('no registry fallback');
  expect(readdirSync(join(dir, 'staging'))).toEqual([]);
});
for (const command of ['build', 'run', 'check']) test(`R3-6 --drop-host-dependencies refuses outside install (${command})`, () => {
  const r = spawnSync(realBun, [resolve('bin/cook'), command, recipe, '--drop-host-dependencies'], { encoding: 'utf8' });
  expect(r.status).not.toBe(0); expect(r.stderr).toContain('--drop-host-dependencies is only supported by install');
});
test('R3-9 announces exactly one fetch before the preview', () => {
  const r = install();
  expect(r.status).toBe(0);
  expect(r.stdout.match(/-> fetching host /g)).toHaveLength(1);
  expect(r.stdout.indexOf('-> fetching host ')).toBeLessThan(r.stdout.indexOf('Host install plan'));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) test(`R3-8 cleanup exceptions still re-raise ${signal}`, async () => {
  const marker = join(dir, 'waiting'), preload = join(dir, 'throw-cleanup.ts');
  writeFileSync(join(shim, 'bun'), `#!/bin/sh\ntouch '${marker}'\nexec sleep 30\n`);
  writeFileSync(preload, `import { spyOn } from 'bun:test';
import * as fs from 'node:fs';
const original = fs.rmSync;
spyOn(fs, 'rmSync').mockImplementation((path, opts) => {
  if (String(path).includes('cook-host-dependency-') && fs.existsSync(${JSON.stringify(marker)})) throw new Error('injected cleanup failure');
  return original(path, opts);
});
`);
  const child = spawn(realBun, ['--preload', preload, resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--no-prompts', '--yes', '--host-dependency', option()], {
    detached: true, stdio: 'ignore', env: { ...process.env, TMPDIR: join(dir, 'staging'), PATH: shim + ':' + process.env.PATH },
  });
  const exited = new Promise<string | null>(resolve => child.on('exit', (_code, signal) => resolve(signal)));
  try {
    const deadline = Date.now() + 4000;
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(marker)).toBe(true);
    child.kill(signal);
    expect(await Promise.race([exited, Bun.sleep(2500).then(() => 'timed out')])).toBe(signal);
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    await exited;
  }
}, 10000);
