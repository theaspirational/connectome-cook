import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { layoutTestDirectory } from './test-layout-directory.js';
import { join, resolve } from 'node:path';
import { checkEngine, preflightHostEngines } from './host-engines.js';

let dir: string, repo: string, bun: string, node: string, recipe: string, out: string;
beforeEach(() => {
  dir = layoutTestDirectory('cook-managed-');
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
  for (const path of [join(c.config, 'recipes/recipe.json'), join(out, 'bunfig.toml'), join(out, '.cook-layout.json'), join(out, 'connectome.lock'), join(out, 'example.service')]) expect(statSync(path).mode & 0o7777).toBe(0o600);
  expect(statSync(join(out, 'run.sh')).mode & 0o7777).toBe(0o700);
  const config = JSON.parse(readFileSync(join(c.config, 'recipes/recipe.json'), 'utf8'));
  expect(config.mcpServers.local.env.SETTINGS).toBe(join(c.state, 'connectors/local/settings/config.json'));
  const launcher = readFileSync(join(out, 'run.sh'), 'utf8');
  expect(launcher).toContain("export DATA_DIR='" + c.state + "'");
  expect(launcher).toContain("cd '" + c.state + "'");
  expect(launcher).toContain("'" + join(c.config, 'recipes/recipe.json') + "'");
  expect(readFileSync(join(out, 'example.service'), 'utf8')).toContain('WorkingDirectory=' + c.state);
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
test('split layout refuses missing engines, unknown state consumers and legacy templates', () => {
  const path = layoutFile();
  expect(install(['--layout', path]).status).not.toBe(0);
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

test('layout R1 runtime: real launcher isolates Bun autoload and cwd state, unit uses bare state', () => {
  const c = splitLayout();
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/index.ts'), `import { writeFileSync } from 'node:fs';
    writeFileSync('mcpl-servers.agent.json', '{}');
    writeFileSync(process.env.DATA_DIR + '/probe.json', JSON.stringify({cwd: process.cwd(), injected: process.env.COOK_LAYOUT_INJECTED, workspace: process.env.WORKSPACE_DIR, args: process.argv.slice(2)}));`);
  execFileSync('git', ['add', 'src/index.ts'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'Runtime probe'], { cwd: repo, stdio: 'pipe' });
  // Keep builds local/offline; the selected executable runs the real Bun only at launch.
  writeFileSync(bun, '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.3; elif [ "$1" != install ]; then exec ' + JSON.stringify(process.execPath) + ' "$@"; fi\n');
  const result = install(['--layout', layoutFile(), '--bun-path', bun, '--node-path', node, '--user-unit', 'example.service']);
  expect(result.status).toBe(0);
  for (const root of [c.workspace, c.state]) {
    writeFileSync(join(root, '.env'), 'COOK_LAYOUT_INJECTED=dotenv\n');
    writeFileSync(join(root, 'bunfig.toml'), 'preload = ["./injection.ts"]\n');
    writeFileSync(join(root, 'injection.ts'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(c.workspace, 'injected'))}, 'bad');`);
  }
  const launched = spawnSync('/bin/bash', [join(out, 'run.sh'), '--headless'], { encoding: 'utf8', env: { ...process.env, COOK_LAYOUT_INJECTED: undefined, BUN_OPTIONS: '--preload ./injection.ts' } });
  expect(launched.status).toBe(0);
  const probe = JSON.parse(readFileSync(join(c.state, 'probe.json'), 'utf8'));
  expect(probe.cwd).toBe(c.state);
  expect(probe.injected).toBeUndefined();
  expect(probe.workspace).toBe(c.workspace);
  expect(probe.args).toEqual([join(c.config, 'recipes/recipe.json'), '--headless']);
  expect(existsSync(join(c.state, 'mcpl-servers.agent.json'))).toBe(true);
  expect(existsSync(join(c.workspace, 'mcpl-servers.agent.json'))).toBe(false);
  expect(existsSync(join(c.workspace, 'injected'))).toBe(false);
  expect(readFileSync(join(out, 'example.service'), 'utf8')).toContain('WorkingDirectory=' + c.state + '\n');
});

test('layout R1 preview: confirms actual config, runtime and reserved roots', () => {
  const c = splitLayout();
  const result = install(['--layout', layoutFile(), '--bun-path', bun, '--node-path', node]);
  expect(result.status).toBe(0);
  for (const path of [join(c.config, 'recipes'), join(c.config, '.env'), join(c.runtime, 'run.sh'), join(c.runtime, 'bunfig.toml'), c.state, c.workspace, c.credentials]) expect(result.stdout).toContain(path);
  expect(result.stdout).not.toContain('under the install dir');
});

test('layout R1 CLI: empty layout and missing engine names refuse before recipe loading', () => {
  rmSync(recipe);
  for (const extra of [['--layout'], ['--layout', ''], ['--layout=']]) {
    const result = install(extra);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('E_HOST_LAYOUT: --layout');
    expect(existsSync(out)).toBe(false);
  }
  const result = install(['--layout', layoutFile()]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('--bun-path');
  expect(result.stderr).toContain('--node-path');
});

test('layout R1 reconcile: unreadable/missing lock, old-cook overwrite and marker removal fail closed', () => {
  const args = ['--layout', layoutFile(), '--bun-path', bun, '--node-path', node];
  expect(install(args).status).toBe(0);
  const lockPath = join(out, 'connectome.lock'), launcherPath = join(out, 'run.sh');
  const lockText = readFileSync(lockPath, 'utf8'), launcher = readFileSync(launcherPath, 'utf8');
  for (const broken of ['', '{', null]) {
    if (broken === null) rmSync(lockPath); else writeFileSync(lockPath, broken);
    for (const extra of [[], args]) {
      const result = install(extra);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('E_HOST_LAYOUT');
      expect(readFileSync(launcherPath, 'utf8')).toBe(launcher);
      expect(existsSync(join(out, 'recipes'))).toBe(false);
    }
  }
  const downgraded = JSON.parse(lockText); delete downgraded.layout;
  writeFileSync(lockPath, JSON.stringify(downgraded));
  writeFileSync(launcherPath, '# old cook default launcher\n');
  expect(install([]).stderr).toContain('E_HOST_LAYOUT');
  expect(install(args).stderr).toContain('E_HOST_LAYOUT');
  // Without a marker, split adoption still refuses any existing launcher.
  writeFileSync(launcherPath, launcher); rmSync(lockPath);
  rmSync(join(out, '.cook-layout.json'), { force: true });
  expect(install(args).stderr).toContain('E_HOST_LAYOUT');
});

test('layout R1 unit: bare state path matrix and terminal-backslash refusal', () => {
  const c = splitLayout(); const file = layoutFile();
  for (const suffix of ['space path', 'quote"path', 'percent%path', 'dollar$path', 'back\\slash']) {
    rmSync(out, { recursive: true, force: true });
    const state = join(dir, suffix); writeFileSync(file, JSON.stringify({ ...c, state }));
    const result = install(['--layout', file, '--bun-path', bun, '--node-path', node, '--user-unit', 'example.service']);
    expect(result.status).toBe(0);
    const unitPath = join(out, 'example.service');
    expect(readFileSync(unitPath, 'utf8')).toContain('WorkingDirectory=' + state.replace(/%/g, '%%') + '\n');
    const runtime = process.env.XDG_RUNTIME_DIR ?? (process.getuid ? `/run/user/${process.getuid()}` : undefined);
    if (runtime && existsSync(runtime) && spawnSync('systemd-analyze', ['--version']).status === 0) {
      const verify = spawnSync('systemd-analyze', ['--user', 'verify', unitPath], { encoding: 'utf8', env: { ...process.env, XDG_RUNTIME_DIR: runtime } });
      expect(verify.status).toBe(0);
      expect(verify.stderr).not.toMatch(/example\.service:\d+:/);
    }
  }
  rmSync(out, { recursive: true, force: true });
  for (const state of [join(dir, 'terminal\\'), join(dir, 'trailing ')]) {
    writeFileSync(file, JSON.stringify({ ...c, state }));
    expect(install(['--layout', file, '--bun-path', bun, '--node-path', node, '--user-unit', 'example.service']).stderr).toContain('E_HOST_UNIT');
    expect(existsSync(out)).toBe(false);
  }
});

test('split workspace mounts rebase structure and preserve mount options, defaults and false', () => {
  const c = splitLayout(), path = layoutFile();
  const original = JSON.parse(readFileSync(recipe, 'utf8'));
  const args = ['--layout', path, '--bun-path', bun, '--node-path', node];
  for (const workspace of [undefined, true, false, { configMount: false, mounts: [
    { name: 'ws', path: './nested/output', mode: 'read-write', watch: 'never' },
    { name: 'all', path: '.' }, { name: 'external', path: join(dir, 'external'), mode: 'read-only' },
  ] }]) {
    writeFileSync(recipe, JSON.stringify({ ...original, modules: { workspace } }));
    expect(install(args).status).toBe(0);
    const lowered = JSON.parse(readFileSync(join(c.config, 'recipes/recipe.json'), 'utf8')).modules.workspace;
    if (workspace === false) expect(lowered).toBe(false);
    else if (typeof workspace === 'object') expect(lowered).toEqual({ ...workspace, mounts: workspace.mounts.map(m => ({ ...m, path: resolve(c.workspace, m.path) })) });
    else expect(lowered.mounts).toEqual([
      { name: 'input', path: join(c.workspace, 'input'), mode: 'read-only' },
      { name: 'products', path: join(c.workspace, 'output'), mode: 'read-write' },
    ]);
  }
});

test('split workspace refuses reserved-root mounts before any build', () => {
  const c = splitLayout(), args = ['--layout', layoutFile(), '--bun-path', bun, '--node-path', node];
  const original = JSON.parse(readFileSync(recipe, 'utf8'));
  for (const path of [c.state, join(c.state, 'sessions'), c.config, c.runtime, c.credentials, '../state', '..']) {
    writeFileSync(recipe, JSON.stringify({ ...original, modules: { workspace: { mounts: [{ name: 'unsafe', path }] } } }));
    const result = install(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('E_HOST_LAYOUT');
    expect(existsSync(out)).toBe(false);
  }
});

for (const mount of ['/', '/./', '//', '../../../../../../../../', 'reserved-parent/']) {
  test(`split workspace root-aware refusal before any build: ${mount}`, () => {
    const c = { ...splitLayout(), state: join(dir, 'reserved-parent/state') };
    const file = layoutFile(); writeFileSync(file, JSON.stringify(c));
    const path = mount === 'reserved-parent/' ? join(dir, mount) + '/' : mount;
    const original = JSON.parse(readFileSync(recipe, 'utf8'));
    writeFileSync(recipe, JSON.stringify({ ...original, modules: { workspace: {
      mounts: [{ name: 'unsafe', path, mode: 'read-write' }],
    } } }));
    const marker = join(dir, 'build-ran');
    writeFileSync(bun, `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.4; else touch '${marker}'; fi\n`);
    const result = install(['--layout', file, '--bun-path', bun, '--node-path', node]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('E_HOST_LAYOUT: workspace mount exposes a reserved root');
    expect(result.stdout).not.toContain('Host install plan');
    expect(existsSync(marker)).toBe(false);
    for (const root of [c.runtime, c.config, c.state, c.workspace, c.credentials]) expect(existsSync(root)).toBe(false);
  });
}

test('split failed first build resumes only the same layout', () => {
  const file = layoutFile(), args = ['--layout', file, '--bun-path', bun, '--node-path', node];
  writeFileSync(bun, '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.4; else exit 42; fi\n');
  expect(install(args).status).toBe(3);
  expect(existsSync(join(out, '.cook-layout.json'))).toBe(true);
  expect(existsSync(join(out, 'connectome.lock'))).toBe(false);
  expect(existsSync(join(out, 'run.sh'))).toBe(false);
  expect(install(['--bun-path', bun, '--node-path', node]).stderr).toContain('E_HOST_LAYOUT');
  writeFileSync(file, JSON.stringify({ ...splitLayout(), state: join(dir, 'other-state') }));
  expect(install(args).stderr).toContain('E_HOST_LAYOUT');
  writeFileSync(file, JSON.stringify(splitLayout()));
  writeFileSync(bun, '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.4; fi\n');
  expect(install(args).status).toBe(0);
  expect(install(args).status).toBe(0);
});

test('split failed reinstall retires reuse lock and remains resumable', () => {
  const args = ['--layout', layoutFile(), '--bun-path', bun, '--node-path', node];
  expect(install(args).status).toBe(0);
  writeFileSync(join(repo, 'new-file'), 'changed');
  execFileSync('git', ['add', 'new-file'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'Change host'], { cwd: repo, stdio: 'pipe' });
  writeFileSync(bun, '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.4; else exit 42; fi\n');
  expect(install(args).status).toBe(3);
  expect(existsSync(join(out, 'connectome.lock'))).toBe(false);
  expect(existsSync(join(out, 'run.sh'))).toBe(true);
  writeFileSync(bun, '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.4; fi\n');
  expect(install(args).status).toBe(0);
});

test('split layout refuses default-install artifacts without a readable lock', () => {
  const args = ['--layout', layoutFile(), '--bun-path', bun, '--node-path', node];
  mkdirSync(out, { mode: 0o700 });
  for (const artifact of ['run.sh', 'recipes', 'data']) {
    if (artifact === 'run.sh') writeFileSync(join(out, artifact), '#!/bin/sh\nexec bun app/src/index.ts\n');
    else mkdirSync(join(out, artifact));
    writeFileSync(join(out, 'connectome.lock'), '{');
    const result = install(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('E_HOST_LAYOUT');
    expect(existsSync(join(out, '.cook-layout.json'))).toBe(false);
    rmSync(join(out, artifact), { recursive: true });
  }
});

test('layout parse, IO, overlap and state-unit errors precede recipe resolution', () => {
  rmSync(recipe);
  const file = layoutFile();
  for (const content of ['{', JSON.stringify({ ...splitLayout(), state: out }), JSON.stringify({ ...splitLayout(), state: join(dir, 'bad\\') })]) {
    writeFileSync(file, content);
    const result = install(['--layout', file, '--bun-path', bun, '--node-path', node, '--user-unit', 'example.service', '--pin-refs']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('E_HOST_LAYOUT: --layout ' + file + ':');
    expect(result.stdout).not.toContain('walking recipe');
    expect(existsSync(out)).toBe(false);
  }
  rmSync(file);
  expect(install(['--layout', file, '--bun-path', bun, '--node-path', node]).stderr).toContain('E_HOST_LAYOUT: --layout ' + file + ':');
});

for (const target of ['.cook-engines', 'example.service']) {
  test(`R3-8 refuses reserved code target ${target} before build`, () => {
    const original = JSON.parse(readFileSync(recipe, 'utf8'));
    original.mcpServers.local.source = { url: repo, install: { run: 'true', runtime: 'custom' }, inContainer: { path: '/' + target } };
    writeFileSync(recipe, JSON.stringify(original));
    const result = install(['--layout', layoutFile(), '--bun-path', bun, '--node-path', node, '--user-unit', 'example.service']);
    expect(result.stderr).toContain('E_HOST_LAYOUT');
    expect(result.stdout).not.toContain('Host install plan');
    expect(existsSync(out)).toBe(false);
  });
}

for (const scenario of [
  { name: 'reviewer repro', copy: false, relativeHint: false, child: false, reexport: false, changeEngine: false },
  { name: 'relative retained hint and descendant', copy: false, relativeHint: true, child: true, reexport: false, changeEngine: false },
  { name: 'different requested unit', copy: false, relativeHint: false, child: false, reexport: true, changeEngine: false },
  { name: 'sibling copy', copy: true, relativeHint: false, child: false, reexport: false, changeEngine: false },
  { name: 'sibling copy with relative hint and re-export', copy: true, relativeHint: true, child: false, reexport: true, changeEngine: false },
  { name: 'engine binding change', copy: false, relativeHint: false, child: false, reexport: false, changeEngine: true },
]) {
  test(`R3-8 retained unit refuses code collision before writes: ${scenario.name}`, () => {
    const args = ['--layout', layoutFile(), '--bun-path', bun, '--node-path', node];
    expect(install([...args, '--user-unit', 'example.service']).status).toBe(0);
    const lockPath = join(out, 'connectome.lock');
    if (scenario.relativeHint) {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      lock.launch.userUnit = 'example.service';
      writeFileSync(lockPath, JSON.stringify(lock));
    }
    const paths = [lockPath, join(out, '.cook-layout.json'), join(out, 'run.sh'), join(out, 'example.service')];
    const before = paths.map(path => readFileSync(path, 'utf8'));
    const original = JSON.parse(readFileSync(recipe, 'utf8'));
    if (scenario.copy) {
      // Unresolved servers use sibling-copy and target /<server name>.
      original.mcpServers['example.service'] = { command: 'node', args: ['fixture.js'] };
      mkdirSync(join(dir, 'example.service'));
      writeFileSync(join(dir, 'example.service/fixture.js'), '// sibling fixture');
    } else {
      original.mcpServers.local.source = {
        url: repo, install: { run: 'true', runtime: 'custom' },
        inContainer: { path: '/example.service' + (scenario.child ? '/checkout' : '') },
      };
    }
    writeFileSync(recipe, JSON.stringify(original));
    if (scenario.changeEngine) {
      const otherNode = join(dir, 'other-node');
      writeFileSync(otherNode, readFileSync(node), { mode: 0o755 });
      args[args.length - 1] = otherNode;
    }
    const result = install([...args, ...(scenario.reexport ? ['--user-unit', 'new.service'] : [])]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E_HOST_LAYOUT');
    expect(result.stdout).not.toContain('Host install plan');
    expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(before);
    expect(statSync(join(out, 'example.service')).isFile()).toBe(true);
    expect(existsSync(join(out, 'new.service'))).toBe(false);
  });
}

// A lexical /app/back/<control> looks harmless, but the tracked link goes
// back to the runtime root. Exercise both destructive source action kinds.
for (const copy of [false, true]) for (const control of [
  'example.service', '.cook-engines/bin', '.cook-layout.json', 'connectome.lock',
]) {
  test(`R3-8 real-path ${copy ? 'copy' : 'clone'} refuses existing alias to ${control} before writes`, () => {
    symlinkSync('..', join(repo, 'back'));
    execFileSync('git', ['add', 'back'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'Tracked ancestor alias'], { cwd: repo, stdio: 'pipe' });
    const args = ['--layout', layoutFile(), '--bun-path', bun, '--node-path', node];
    expect(install([...args, '--user-unit', 'example.service']).status).toBe(0);
    const paths = ['connectome.lock', '.cook-layout.json', 'run.sh', 'example.service'].map(p => join(out, p));
    const before = paths.map(p => readFileSync(p, 'utf8'));
    const links = ['bun', 'node'].map(p => join(out, '.cook-engines/bin', p));
    const linkTargets = links.map(p => readlinkSync(p));
    const original = JSON.parse(readFileSync(recipe, 'utf8'));
    const target = 'app/back/' + control;
    if (copy) {
      original.mcpServers[target] = { command: 'node', args: ['fixture.js'] };
      mkdirSync(join(dir, target), { recursive: true });
      writeFileSync(join(dir, target, 'fixture.js'), '// sibling fixture');
    } else {
      original.mcpServers.local.source = { url: repo, inContainer: { path: '/' + target } };
    }
    writeFileSync(recipe, JSON.stringify(original));
    // Deliberately omit --user-unit: the retained export is still reserved.
    const result = install(args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E_HOST_LAYOUT');
    expect(result.stderr).toContain(join(out, target));
    expect(result.stdout).not.toContain('Host install plan');
    expect(paths.map(p => readFileSync(p, 'utf8'))).toEqual(before);
    expect(links.map(p => readlinkSync(p))).toEqual(linkTargets);
  });
}

for (const copy of [false, true]) {
  test(`R3-8 real-path ${copy ? 'copy' : 'clone'} rechecks alias created by earlier host clone`, () => {
    symlinkSync('..', join(repo, 'back'));
    execFileSync('git', ['add', 'back'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'Tracked ancestor alias'], { cwd: repo, stdio: 'pipe' });
    const original = JSON.parse(readFileSync(recipe, 'utf8'));
    const target = 'app/back/example.service';
    if (copy) {
      original.mcpServers[target] = { command: 'node', args: ['fixture.js'] };
      mkdirSync(join(dir, target), { recursive: true });
      writeFileSync(join(dir, target, 'fixture.js'), '// sibling fixture');
    } else original.mcpServers.local.source = { url: repo, inContainer: { path: '/' + target } };
    writeFileSync(recipe, JSON.stringify(original));
    const result = install(['--layout', layoutFile(), '--bun-path', bun, '--node-path', node, '--user-unit', 'example.service']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E_HOST_LAYOUT');
    expect(result.stderr).toContain(join(out, target));
    // Preflight could not see this link; it must be checked after host clone.
    expect(lstatSync(join(out, 'app/back')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(out, 'example.service'))).toBe(false);
    expect(lstatSync(join(out, '.cook-engines/bin/bun')).isSymbolicLink()).toBe(true);
  });
}

for (const path of ['${AGENT_NOTES}/x', '${ESCAPE}']) {
  test(`R3-1 CLI refuses variable mount ${path} before builds`, () => {
    const original = JSON.parse(readFileSync(recipe, 'utf8'));
    original.modules = { workspace: { mounts: [{ name: 'notes', path }] } };
    writeFileSync(recipe, JSON.stringify(original));
    const result = install(['--layout', layoutFile(), '--bun-path', bun, '--node-path', node]);
    expect(result.stderr).toContain('E_HOST_LAYOUT');
    expect(result.stderr).toContain('notes');
    expect(result.stdout).not.toContain('Host install plan');
    expect(existsSync(out)).toBe(false);
  });
}

for (const server of [
  { command: './bin/tool' }, { command: '../tools/server' },
  { command: 'node', args: ['--enable-x', './tools/x.js'] },
]) {
  test(`R3-2 CLI refuses remaining relative stdio ${JSON.stringify(server)}`, () => {
    writeFileSync(recipe, JSON.stringify({ name: 'Test', agent: { systemPrompt: 'Test' }, mcpServers: { local: server } }));
    const result = install(['--layout', layoutFile(), '--bun-path', bun, '--node-path', node]);
    expect(result.stderr).toContain('E_HOST_LAYOUT');
    expect(result.stderr).toContain('local');
    expect(result.stderr).toContain(server.command.startsWith('.') ? server.command : server.args!.at(-1)!);
    expect(result.stdout).not.toContain('Host install plan');
    expect(existsSync(out)).toBe(false);
  });
}

test('R3-3 build and run reject layout before resolving or launching a target', () => {
  for (const command of ['build', 'run']) for (const extra of [['--layout'], ['--layout='], ['--layout', '/missing/layout.json']]) {
    const result = spawnSync(process.execPath, [resolve('bin/cook'), command, recipe, ...extra], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('E_HOST_LAYOUT');
  }
  // A materialized directory must not bypass the run parser's refusal.
  expect(install(['--bun-path', bun, '--node-path', node]).status).toBe(0);
  const run = spawnSync(process.execPath, [resolve('bin/cook'), 'run', out, '--layout', '/missing'], { encoding: 'utf8' });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain('E_HOST_LAYOUT');
  const help = spawnSync(process.execPath, [resolve('bin/cook'), 'build', '--help'], { encoding: 'utf8' });
  expect(help.stdout).not.toContain('--layout');
});

test('R3-9 preview labels defaults conditionally for disabled and explicit workspaces', () => {
  for (const workspace of [false, { mounts: [{ name: 'custom', path: './custom' }] }]) {
    const original = JSON.parse(readFileSync(recipe, 'utf8'));
    writeFileSync(recipe, JSON.stringify({ ...original, modules: { workspace } }));
    const result = install(['--layout', layoutFile(), '--bun-path', bun, '--node-path', node]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Implicit mounts:');
    expect(result.stdout).toContain('Default mounts (only when workspace is unset/true)');
  }
});

test('R3-9 refuses unreleased raw-layout marker format', () => {
  const args = ['--layout', layoutFile(), '--bun-path', bun, '--node-path', node];
  expect(install(args).status).toBe(0);
  writeFileSync(join(out, '.cook-layout.json'), JSON.stringify(splitLayout()));
  expect(install(args).stderr).toContain('E_HOST_LAYOUT: unreadable runtime layout marker');
});
