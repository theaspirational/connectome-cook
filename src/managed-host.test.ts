import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkEngine, preflightHostEngines } from './host-engines.js';
import { renderLauncher } from './backends/host.js';

let dir: string, repo: string, bun: string, node: string, recipe: string, out: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cook-managed-'));
  repo = join(dir, 'source'); mkdirSync(repo);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.org']);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'host-fixture', engines: { bun: '>=1.4.3', node: '>=22.12.0' } }));
  git(['add', 'package.json']); git(['commit', '-m', 'Fixture host']);
  bun = join(dir, 'bun'); node = join(dir, 'node');
  writeFileSync(bun, '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.4; fi\n'); chmodSync(bun, 0o755);
  writeFileSync(node, '#!/bin/sh\necho v22.23.3\n'); chmodSync(node, 0o755);
  mkdirSync(join(dir, 'local')); writeFileSync(join(dir, 'local/fixture.js'), '// build-only fixture');
  recipe = join(dir, 'recipe.json'); out = join(dir, 'install');
  writeFileSync(recipe, JSON.stringify({ name: 'Fixture', agent: { systemPrompt: 'Test' }, mcpServers: { local: { command: 'node', args: ['fixture.js'] } } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function install(extra: string[] = []) {
  return spawnSync(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--ch-ref', 'main', '--no-prompts', '--yes', ...extra], { encoding: 'utf8' });
}
test('engine preflight checks selected source, pins commit, and records absolute engines through CLI', () => {
  const checked = preflightHostEngines(repo, 'main', bun, node);
  expect(checked.commit).toMatch(/^[a-f0-9]{40}$/);
  const result = install(['--bun-path', bun, '--node-path', node]);
  if (result.status) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
  const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
  expect(lock.engines).toEqual(checked.engines);
  expect(lock.connectomeHost.commit).toBe(checked.commit);
  expect(readFileSync(join(out, 'run.sh'), 'utf8')).toContain("exec '" + bun + "'");
  const config = JSON.parse(readFileSync(join(out, 'recipes/recipe.json'), 'utf8'));
  expect(config.mcpServers.local.command).toBe(node);
});
test('engine refusals precede install directory creation', () => {
  for (const extra of [
    ['--bun-path', bun], ['--node-path', node],
    ['--bun-path', 'bun', '--node-path', node],
    ['--bun-path', bun, '--node-path', '/nonexistent/node'],
  ]) {
    expect(install(extra).status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  }
  writeFileSync(node, '#!/bin/sh\necho v20.0.0\n');
  expect(install(['--bun-path', bun, '--node-path', node]).status).not.toBe(0);
  expect(existsSync(out)).toBe(false);
});
test('invalid versions, ranges, permissions and missing engines fail closed', () => {
  for (const range of [undefined, '', 'not-a-range', '>=99']) expect(() => checkEngine(bun, range)).toThrow('E_HOST_ENGINE');
  writeFileSync(bun, '#!/bin/sh\necho bad\n');
  expect(() => checkEngine(bun, '*')).toThrow('E_HOST_ENGINE');
  chmodSync(bun, 0o600);
  expect(() => checkEngine(bun, '*')).toThrow('E_HOST_ENGINE');
  expect(() => preflightHostEngines(repo, 'missing', bun, node)).toThrow('E_HOST_ENGINE');
  writeFileSync(join(repo, 'package.json'), '{}');
  execFileSync('git', ['commit', '-am', 'Missing engines'], { cwd: repo, stdio: 'pipe' });
  expect(() => preflightHostEngines(repo, 'main', node, node)).toThrow('E_HOST_ENGINE');
});
test('held launcher remains an immutable refusal with selected engines', () => {
  const launcher = join(dir, 'held.sh');
  writeFileSync(launcher, renderLauncher('recipe.json', { hasSidecars: false, envsubstFiles: [], candidate: true, engines: { bun: { path: bun, version: '1.4.4' }, node: { path: node, version: '22.23.3' } } }));
  const result = spawnSync('/bin/bash', [launcher], { encoding: 'utf8' });
  expect(result.stderr).toContain('E_HELD: disposable candidate is held; activation is not supported.');
  expect(result.stderr).not.toContain('PR01b');
  expect(result.status).toBe(4);
});

test('CLI exports a headless private journal user unit without service calls', () => {
  const result = install(['--bun-path', bun, '--node-path', node, '--user-unit', 'example.service']);
  expect(result.status).toBe(0);
  const unit = readFileSync(join(out, 'example.service'), 'utf8');
  expect(unit).toContain('ExecStart=/bin/bash "' + join(out, 'run.sh') + '" --headless');
  expect(unit).toContain('WorkingDirectory="' + out + '"');
  for (const required of ['Restart=on-failure', 'UMask=0077', 'StandardOutput=journal', 'StandardError=journal']) expect(unit).toContain(required);
  const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
  expect(lock.launch.userUnit).toBe(join(out, 'example.service'));
});
test('unit export refuses unsafe names and missing selected engines without materializing', () => {
  expect(install(['--user-unit', 'example.service']).status).not.toBe(0);
  for (const name of ['../bad.service', 'bad\n.service', 'bad@.service', 'run.sh', '']) {
    expect(install(['--bun-path', bun, '--node-path', node, '--user-unit', name]).status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  }
});

test('held preparation rejects user-unit export before reserving output', () => {
  const result = install(['--hold', '--user-unit', 'example.service']);
  expect(result.status).not.toBe(0);
  expect(existsSync(out)).toBe(false);
});

function splitLayout() {
  return { schema: 'connectome.host-layout/v1', runtime: out, config: join(dir, 'config'), state: join(dir, 'state'), workspace: join(dir, 'workspace'), credentials: join(dir, 'credentials'), connectorState: { local: { SETTINGS: 'settings/config.json' } } };
}
function layoutFile() {
  const path = join(dir, 'layout.json'); writeFileSync(path, JSON.stringify(splitLayout())); return path;
}
test('CLI split install separates configuration, code, state and workspace and exports static unit', () => {
  const c = splitLayout();
  const args = ['--bun-path', bun, '--node-path', node, '--layout', layoutFile(), '--user-unit', 'example.service'];
  const result = install(args);
  if (result.status) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
  expect(existsSync(join(c.config, 'recipes/recipe.json'))).toBe(true);
  expect(existsSync(join(out, 'recipes'))).toBe(false);
  const config = JSON.parse(readFileSync(join(c.config, 'recipes/recipe.json'), 'utf8'));
  expect(config.mcpServers.local.env.SETTINGS).toBe(join(c.state, 'connectors/local/settings/config.json'));
  const launcher = readFileSync(join(out, 'run.sh'), 'utf8');
  expect(launcher).toContain("export DATA_DIR='" + c.state + "'");
  expect(launcher).toContain("cd '" + c.workspace + "'");
  expect(launcher).toContain("'" + join(c.config, 'recipes/recipe.json') + "'");
  expect(readFileSync(join(out, 'example.service'), 'utf8')).toContain('WorkingDirectory="' + c.workspace + '"');
  expect(install(args).status).toBe(0);
  expect(install(['--bun-path', bun, '--node-path', node]).status).not.toBe(0);
});
test('split layout reinstall ignores root, consumer and environment key order but rejects changed paths', () => {
  const c = {
    ...splitLayout(),
    connectorState: {
      local: { FIRST: 'settings/first.json', SECOND: 'settings/second.json' },
      other: { THIRD: 'third.json', FOURTH: 'fourth.json' },
    },
  };
  const original = JSON.parse(readFileSync(recipe, 'utf8'));
  original.mcpServers.other = { ...original.mcpServers.local };
  writeFileSync(recipe, JSON.stringify(original));
  mkdirSync(join(dir, 'other')); writeFileSync(join(dir, 'other/fixture.js'), '// build-only fixture');
  const path = join(dir, 'reordered-layout.json');
  writeFileSync(path, JSON.stringify(c));
  const args = ['--bun-path', bun, '--node-path', node, '--layout', path];
  expect(install(args).status).toBe(0);
  const reordered: Record<string, unknown> = Object.fromEntries(Object.entries(c).reverse());
  reordered.connectorState = Object.fromEntries(Object.entries(c.connectorState).reverse().map(
    ([consumer, env]) => [consumer, Object.fromEntries(Object.entries(env).reverse())],
  ));
  writeFileSync(path, JSON.stringify(reordered));
  const result = install(args);
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain('E_HOST_LAYOUT');
  writeFileSync(path, JSON.stringify({ ...c, connectorState: { ...c.connectorState, local: { ...c.connectorState.local, FIRST: 'changed.json' } } }));
  const changed = install(args);
  expect(changed.status).not.toBe(0);
  expect(changed.stderr).toContain('E_HOST_LAYOUT');
});
test('split layout refuses missing engines, unknown state consumers, legacy templates and held preparation', () => {
  const path = layoutFile();
  expect(install(['--layout', path]).status).not.toBe(0);
  expect(install(['--layout', path, '--hold']).status).not.toBe(0);
  const c = { ...splitLayout(), connectorState: { missing: { SETTINGS: 'file' } } };
  writeFileSync(path, JSON.stringify(c));
  expect(install(['--layout', path, '--bun-path', bun, '--node-path', node]).status).not.toBe(0);
  writeFileSync(path, JSON.stringify(splitLayout()));
  const original = JSON.parse(readFileSync(recipe, 'utf8'));
  original.containerTemplateFiles = [{ path: '/app/settings.json', content: 'settings' }];
  writeFileSync(recipe, JSON.stringify(original));
  expect(install(['--layout', path, '--bun-path', bun, '--node-path', node]).status).not.toBe(0);
  expect(existsSync(out)).toBe(false);
});

test('installed named credential adapter launches only a fake consumer; artifacts contain no file values', () => {
  node = Bun.which('node')!;
  const c = splitLayout();
  const bindings = { schema: 'connectome.credential-bindings/v1', root: c.credentials, files: { token: 'token' }, consumers: { local: { API_TOKEN: 'token' } } };
  const path = join(dir, 'bindings.json'); writeFileSync(path, JSON.stringify(bindings));
  mkdirSync(c.credentials, { mode: 0o700 });
  const synthetic = 'synthetic-file-value-not-for-artifacts';
  writeFileSync(join(c.credentials, 'token'), synthetic, { mode: 0o600 });
  writeFileSync(join(dir, 'local/fixture.js'), 'process.stdout.write(JSON.stringify({ value: process.env.API_TOKEN, args: process.argv.slice(2) }));');
  const args = ['--bun-path', bun, '--node-path', node, '--layout', layoutFile(), '--credential-bindings', path];
  const result = install(args);
  if (result.status) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
  const config = JSON.parse(readFileSync(join(c.config, 'recipes/recipe.json'), 'utf8'));
  const server = config.mcpServers.local;
  expect(server.command).toBe(node);
  expect(server.env.SETTINGS).toBe(join(c.state, 'connectors/local/settings/config.json'));
  const launched = spawnSync(server.command, server.args, { encoding: 'utf8', env: { PATH: process.env.PATH } });
  expect(launched.status).toBe(0);
  expect(JSON.parse(launched.stdout)).toEqual({ value: synthetic, args: [] });
  for (const file of [join(c.config, 'recipes/recipe.json'), join(out, 'connectome.lock'), join(out, 'run.sh'), ...server.args]) expect(readFileSync(file, 'utf8')).not.toContain(synthetic);
  expect(install(args).status).toBe(0);
});
test('credential integration refuses missing engines, held preparation, unknown consumers, conflicting roots and env', () => {
  const bindings = { schema: 'connectome.credential-bindings/v1', root: join(dir, 'credentials'), files: { token: 'token' }, consumers: { local: { API_TOKEN: 'token' } } };
  const path = join(dir, 'bindings.json');
  writeFileSync(path, JSON.stringify(bindings));
  expect(install(['--credential-bindings', path]).status).not.toBe(0);
  expect(install(['--credential-bindings', path, '--hold']).status).not.toBe(0);
  for (const patch of [
    { root: out }, { root: join(out, 'credentials') },
    { consumers: { missing: { API_TOKEN: 'token' } } },
    { consumers: { local: { SETTINGS: 'token' } } },
  ]) {
    writeFileSync(path, JSON.stringify({ ...bindings, ...patch }));
    expect(install(['--bun-path', bun, '--node-path', node, '--layout', layoutFile(), '--credential-bindings', path]).status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  }
});

test('credential declaration parse failures redact accidentally supplied content', () => {
  const path = join(dir, 'bindings.json');
  const sentinel = 'synthetic-accidental-secret-in-invalid-json';
  writeFileSync(path, '{ "root": "' + sentinel + '" broken json }');
  const result = install(['--bun-path', bun, '--node-path', node, '--credential-bindings', path]);
  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).not.toContain(sentinel);
  expect(existsSync(out)).toBe(false);
});
