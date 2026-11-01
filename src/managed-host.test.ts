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
