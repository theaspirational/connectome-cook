import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkEngine, preflightHostEngines } from './host-engines.js';

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
  checked.cleanup();
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
test('CLI exports a headless private journal user unit without service calls', () => {
  const result = install(['--bun-path', bun, '--node-path', node, '--user-unit', 'example.service']);
  expect(result.status).toBe(0);
  const unit = readFileSync(join(out, 'example.service'), 'utf8');
  expect(unit).toContain('ExecStart=/bin/bash "' + join(out, 'run.sh') + '" --headless');
  expect(unit).toContain('WorkingDirectory=' + out);
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


test('invalid unit options fail before recipe loading or engine fetch', () => {
  rmSync(recipe);
  for (const extra of [
    ['--user-unit', 'example.service'],
    ['--bun-path', bun, '--node-path', node, '--user-unit', 'a'.repeat(248) + '.service'],
  ]) {
    const result = install(extra);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E_HOST_UNIT');
    expect(result.stderr).not.toContain('ENOENT');
    expect(existsSync(out)).toBe(false);
  }
  const missing = install(['--user-unit', 'example.service']);
  expect(missing.stderr).toContain('--bun-path');
  expect(missing.stderr).toContain('--node-path');
});

test('CLI launcher binds env-node scripts via private engine PATH without importing engine siblings', () => {
  const tools = join(dir, 'tools'); mkdirSync(tools);
  const unselected = join(dir, 'unselected'); mkdirSync(unselected);
  // A non-literal stdio command found on the inherited PATH.
  writeFileSync(join(tools, 'npx'), '#!/usr/bin/env node\n', { mode: 0o755 });
  // Sibling executables of selected engines must not be imported into PATH.
  writeFileSync(join(dir, 'npx'), '#!/bin/sh\necho WRONG_SIBLING\n', { mode: 0o755 });
  writeFileSync(join(unselected, 'node'), '#!/bin/sh\necho WRONG_NODE\n', { mode: 0o755 });
  writeFileSync(node, '#!/bin/sh\nif [ "$1" = --version ]; then echo v22.23.3; else echo SELECTED_NODE; fi\n');
  writeFileSync(bun, '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.4; elif [ "$1" = src/index.ts ]; then exec npx; fi\n');
  writeFileSync(recipe, JSON.stringify({ name: 'Fixture', agent: { systemPrompt: 'Test' }, mcpServers: { local: { command: 'npx', args: [] } } }));
  expect(install(['--bun-path', bun, '--node-path', node, '--user-unit', 'example.service']).status).toBe(0);
  const config = JSON.parse(readFileSync(join(out, 'recipes/recipe.json'), 'utf8'));
  expect(config.mcpServers.local.command).toBe('npx');
  const result = spawnSync('/bin/bash', [join(out, 'run.sh'), '--headless'], {
    encoding: 'utf8', env: { PATH: tools + ':' + unselected + ':/usr/bin:/bin' },
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('SELECTED_NODE');
});

test('repeated CLI export restores mode 0600 and retains differently named units', () => {
  const args = ['--bun-path', bun, '--node-path', node, '--user-unit', 'example.service'];
  expect(install(args).status).toBe(0);
  const unit = join(out, 'example.service');
  expect(statSync(unit).mode & 0o777).toBe(0o600);
  chmodSync(unit, 0o644);
  expect(install(args).status).toBe(0);
  expect(statSync(unit).mode & 0o777).toBe(0o600);
  args[args.length - 1] = 'renamed.service';
  expect(install(args).status).toBe(0);
  expect(existsSync(unit)).toBe(true);
  const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
  expect(lock.launch.userUnit).toBe(join(out, 'renamed.service'));
});

test('six-case path matrix preserves valid bare exports and refuses terminal backslash', () => {
  // Like the renderer parser tests, establish parser availability independently.
  const probe = join(dir, 'probe.service');
  writeFileSync(probe, '[Service]\nExecStart=/bin/true\n');
  const available = spawnSync('systemd-analyze', ['--user', 'verify', probe], { encoding: 'utf8' });
  if (available.error || available.status !== 0) console.warn('SKIP CLI parser checks: ' + (available.error?.message ?? available.stderr));
  for (const suffix of ['ordinary', 'space path', 'percent %h', 'unicode λ雪', 'install %h "quoted"\\path/$HOME', 'ends-in-backslash\\']) {
    out = join(dir, suffix);
    const result = install(['--bun-path', bun, '--node-path', node, '--user-unit', 'example.service']);
    if (suffix.endsWith('\\')) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('E_HOST_UNIT: installation path must not end in a backslash');
      expect(existsSync(out)).toBe(false);
      continue;
    }
    expect(result.status).toBe(0);
    const file = join(out, 'example.service');
    expect(readFileSync(file, 'utf8')).toContain('WorkingDirectory=' + out.replace(/%/g, '%%') + '\n');
    if (!available.error && available.status === 0) {
      const verified = spawnSync('systemd-analyze', ['--user', 'verify', file], { encoding: 'utf8' });
      expect(verified.stderr.split('\n').filter(line => line.includes('example.service:'))).toEqual([]);
      expect(verified.status).toBe(0);
    }
  }
});

test('unsafe export paths fail before recipe loading, prompts or install writes', () => {
  rmSync(recipe);
  for (const suffix of ['end\\', 'end\\\\', 'end\\\\\\', 'new\nline', 'carriage\rreturn', 'trailing ']) {
    out = join(dir, suffix);
    for (const existing of [false, true]) {
      if (existing) { mkdirSync(out); writeFileSync(join(out, 'sentinel'), 'unchanged'); }
      const result = spawnSync(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out,
        '--ch-repo', repo, '--bun-path', bun, '--node-path', node, '--user-unit', 'example.service'],
        { encoding: 'utf8', timeout: 5000 }); // Prompts enabled: validation must still be first.
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('E_HOST_UNIT');
      expect(result.stderr).not.toContain('ENOENT');
      expect(result.stdout).not.toContain('Host install plan');
      if (existing) {
        expect(readdirSync(out)).toEqual(['sentinel']);
        expect(readFileSync(join(out, 'sentinel'), 'utf8')).toBe('unchanged');
      } else expect(existsSync(out)).toBe(false);
    }
  }
});

test('reinstall without unit export warns before confirmation and retains the hint with selected engines', () => {
  const engines = ['--bun-path', bun, '--node-path', node];
  expect(install([...engines, '--user-unit', 'example.service']).status).toBe(0);
  const lockPath = join(out, 'connectome.lock');
  const previousLock = readFileSync(lockPath, 'utf8');
  const denied = install([...engines, '--no-yes']);
  expect(denied.status).toBe(1);
  expect(denied.stderr).toContain('previously exported user unit');
  expect(denied.stderr.indexOf('previously exported user unit'))
    .toBeLessThan(denied.stderr.indexOf('non-interactive mode requires --yes'));
  expect(readFileSync(lockPath, 'utf8')).toBe(previousLock);
  const result = install(engines);
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('previously exported user unit');
  expect(JSON.parse(readFileSync(lockPath, 'utf8')).launch.userUnit).toBe(join(out, 'example.service'));
  // Keep warning on subsequent reinstalls, not just the first omission.
  expect(install(engines).stderr).toContain('previously exported user unit');
  const otherNode = join(dir, 'other-node');
  writeFileSync(otherNode, readFileSync(node), { mode: 0o755 });
  expect(install(['--bun-path', bun, '--node-path', otherNode]).status).toBe(0);
  expect(JSON.parse(readFileSync(lockPath, 'utf8')).launch.userUnit).toBe(join(out, 'example.service'));
});

test('leaving selected engines warns about the installed unit before confirmation or writes', () => {
  expect(install(['--bun-path', bun, '--node-path', node, '--user-unit', 'example.service']).status).toBe(0);
  const previousLauncher = readFileSync(join(out, 'run.sh'), 'utf8');
  const denied = install(['--no-yes']);
  expect(denied.status).toBe(1);
  expect(denied.stderr).toContain('previously exported user unit');
  expect(denied.stderr).toContain('unvalidated PATH engines');
  expect(denied.stderr.indexOf('previously exported user unit'))
    .toBeLessThan(denied.stderr.indexOf('non-interactive mode requires --yes'));
  expect(readFileSync(join(out, 'run.sh'), 'utf8')).toBe(previousLauncher);
  expect(existsSync(join(out, '.cook-engines/bin/bun'))).toBe(true);
  const result = install();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('previously exported user unit');
  expect(existsSync(join(out, 'example.service'))).toBe(true);
  expect(existsSync(join(out, '.cook-engines'))).toBe(false);
  expect(JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8')).launch.userUnit).toBeUndefined();
});

test('explicit re-export names the unit in its description without an omission warning', () => {
  const args = ['--bun-path', bun, '--node-path', node, '--user-unit', 'example.service'];
  expect(install(args).status).toBe(0);
  const result = install(args);
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain('previously exported user unit');
  expect(readFileSync(join(out, 'example.service'), 'utf8')).toContain('Description=Connectome host (example.service)');
});

test('colon unit paths refuse before recipe loading and install writes', () => {
  rmSync(recipe);
  out = join(dir, 'a:b');
  const result = install(['--bun-path', bun, '--node-path', node, '--user-unit', 'example.service']);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('E_HOST_ENGINE_PATH');
  expect(result.stderr).not.toContain('ENOENT');
  expect(existsSync(out)).toBe(false);
});
