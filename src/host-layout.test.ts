import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { layoutTestDirectory } from './test-layout-directory.js';
import { applyWorkspaceMounts, validateLayoutStdio } from './host-layout.js';
import { generateOverlays } from './generators/overlay.js';
import { lowerToConfiguration } from './configuration.js';
import { detectSources } from './source-detector.js';
import type { Recipe } from './vendor/recipe.js';
import { hostLayout, provisionLayout, validateLayoutConsumers, type HostLayout } from './host-layout.js';
import { provisionPrivateDirectory, writePrivateLayoutFile } from './private-directory.js';

let dir: string;
beforeEach(() => { dir = layoutTestDirectory('cook-layout-'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function layout(): HostLayout {
  return { schema: 'connectome.host-layout/v1', config: join(dir, 'config'), runtime: join(dir, 'runtime'), state: join(dir, 'state'), workspace: join(dir, 'workspace'), credentials: join(dir, 'credentials'), connectorState: { local: { SETTINGS: 'settings/config.json' } } };
}
test('layout provisions five private independent roots and connector-state parents', () => {
  const c = hostLayout(layout(), join(dir, 'runtime')); provisionLayout(c);
  for (const p of [c.config, c.runtime, c.state, c.workspace, c.credentials, join(c.config, 'recipes'), join(c.state, 'connectors/local/settings')]) {
    expect(lstatSync(p).mode & 0o7777).toBe(0o700);
    expect(lstatSync(p).uid).toBe(process.geteuid!());
  }
});
test('layout refuses malformed roots, overlap, traversal, unknown fields and state consumers', () => {
  const c = layout();
  for (const patch of [
    { config: 'relative' }, { config: c.runtime }, { state: c.runtime + '/data' },
    { state: dir + '/state/../escape' }, { workspace: '/tmp/bad\npath' },
    { runtime: dir + '/different' }, { extra: 'value' }, { schema: 'wrong' },
    { connectorState: null }, { connectorState: { local: { BAD: '../escape' } } },
    { connectorState: { '../local': { BAD: 'file' } } },
    { connectorState: { local: { 'BAD-NAME': 'file' } } },
  ]) expect(() => hostLayout({ ...c, ...patch }, c.runtime)).toThrow('E_HOST_LAYOUT');
  for (const recipes of [[], [{ name: 'Test', agent: { systemPrompt: 'Test' }, mcpServers: { local: { url: 'ws://localhost/' } } }]]) expect(() => validateLayoutConsumers(c, recipes)).toThrow('E_HOST_LAYOUT');
  expect(existsSync(c.runtime)).toBe(false);
});
test('provisioning refuses unsafe existing modes, symlinks, files and wrong owners without tightening', () => {
  const c = layout(); mkdirSync(c.state, { mode: 0o755 });
  expect(() => hostLayout(c, c.runtime)).toThrow('E_HOST_LAYOUT');
  expect(lstatSync(c.state).mode & 0o777).toBe(0o755);
  expect(existsSync(c.runtime)).toBe(false);
  symlinkSync(c.state, c.config);
  expect(() => provisionPrivateDirectory(c.config)).toThrow();
  expect(() => provisionPrivateDirectory(c.config + '/nested')).toThrow();
  writeFileSync(c.workspace, 'not a directory');
  expect(() => provisionPrivateDirectory(c.workspace)).toThrow();
  for (const path of ['relative', '/', dir + '/../bad']) expect(() => provisionPrivateDirectory(path)).toThrow();
  if (process.geteuid!() === 0) {
    chmodSync(c.state, 0o700); chownSync(c.state, 1, 1);
    expect(() => provisionPrivateDirectory(c.state)).toThrow('E_PRIVATE_OWNER');
  }
});

test('layout R1 diagnostics identify the root, path and unsafe property', () => {
  const c = layout(); mkdirSync(c.state, { mode: 0o750 });
  expect(() => hostLayout(c, c.runtime)).toThrow('state');
  expect(() => hostLayout(c, c.runtime)).toThrow(c.state);
  expect(() => hostLayout(c, c.runtime)).toThrow('E_PRIVATE_MODE');
  chmodSync(c.state, 0o700); symlinkSync(c.state, c.workspace);
  expect(() => hostLayout(c, c.runtime)).toThrow('workspace');
  expect(() => hostLayout(c, c.runtime)).toThrow('E_PRIVATE_PATH');
  rmSync(c.workspace);
  expect(() => hostLayout({ ...c, config: c.state + '/nested' }, c.runtime)).toThrow('state');
  expect(() => hostLayout({ ...c, config: 'relative' }, c.runtime)).toThrow('config');
});

test('connector file and parent mappings refuse in either order', () => {
  const c = layout();
  for (const env of [{ SETTINGS: 'settings', REMINDERS: 'settings/reminders.json' }, { REMINDERS: 'settings/reminders.json', SETTINGS: 'settings' }]) {
    expect(() => hostLayout({ ...c, connectorState: { local: env } }, c.runtime)).toThrow('E_HOST_LAYOUT');
  }
});

test('non-sticky writable ancestors refuse; shell-created sticky ancestors remain supported', () => {
  const parent = join(dir, 'shared'); mkdirSync(parent, { mode: 0o777 }); chmodSync(parent, 0o777);
  expect(() => provisionPrivateDirectory(join(parent, 'private'))).toThrow('E_PRIVATE_ANCESTOR');
  expect(existsSync(join(parent, 'private'))).toBe(false);
  execFileSync('chmod', ['1777', parent]);
  expect(() => provisionPrivateDirectory(join(parent, 'private'))).not.toThrow();
});

test('layout root distinctness includes opened device/inode identities', () => {
  const c = layout(); provisionLayout(c);
  const original = fs.fstatSync;
  const config = fs.statSync(c.config);
  const mocked = spyOn(fs, 'fstatSync').mockImplementation(((fd: number) =>
    fs.readlinkSync('/proc/self/fd/' + fd) === c.state ? config : original(fd)) as typeof fs.fstatSync);
  try {
    let message = '';
    try { hostLayout(c, c.runtime); } catch (err) { message = (err as Error).message; }
    expect(message).toBe(`E_HOST_LAYOUT: state: ${c.state}: root aliases another root (device/inode)`);
  }
  finally { mocked.mockRestore(); }
});

test('private control replacement is atomic and keeps the original on a failed file fsync', () => {
  const file = join(dir, '.cook-layout.json');
  writePrivateLayoutFile(file, 'original', 0o600);
  const before = fs.statSync(file);
  writePrivateLayoutFile(file, 'replacement', 0o600);
  expect(fs.statSync(file).ino).not.toBe(before.ino);
  const sync = fs.fsyncSync;
  const mocked = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (fs.fstatSync(fd).isFile()) throw new Error('injected fsync failure');
    sync(fd);
  });
  try { expect(() => writePrivateLayoutFile(file, 'incomplete', 0o600)).toThrow('injected'); }
  finally { mocked.mockRestore(); }
  expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
  expect(fs.readdirSync(dir)).toEqual(['.cook-layout.json']);
  fs.linkSync(file, join(dir, 'alias'));
  expect(() => writePrivateLayoutFile(file, 'bad', 0o600)).toThrow('E_PRIVATE_FILE');
});

for (const path of ['${AGENT_NOTES}/x', '${ESCAPE}']) {
  test(`R3-1 refuses variable mount ${path} naming the mount`, () => {
    const recipe: Recipe = { name: 'Test', agent: { systemPrompt: 'Test' }, modules: { workspace: { mounts: [{ name: 'notes', path }] } } };
    expect(() => applyWorkspaceMounts(recipe, layout())).toThrow(/E_HOST_LAYOUT:.*notes/);
  });
}

for (const [command, args, install] of [
  ['python3', ['../pipy/server.py'], 'pip-editable'],
  ['./bin/tool', [], undefined],
  ['../tools/server', [], undefined],
  ['node', ['--enable-x', './tools/x.js'], undefined],
  ['node', ['./tools/x.js'], 'npm'],
] as const) {
  test(`R3-2 validates lowered stdio ${command} ${args.join(' ')}`, () => {
    const recipe: Recipe = { name: 'Test', agent: { systemPrompt: 'Test' }, mcpServers: { tool: { command, args: [...args],
      ...(install ? { source: { url: 'https://example.invalid/pipy.git', install } } : {}),
    } } };
    const walks = [{ path: '/fixture/recipe.json', recipe }];
    const sources = detectSources(walks, { strict: false }).map(s => ({ ...s, inContainerPath: layout().runtime + s.inContainerPath }));
    const overlays = generateOverlays({ walks, sources, envVars: [], options: { outDir: layout().runtime, strict: false, noPrompts: true, pinRefs: false } });
    const configuration = lowerToConfiguration(recipe, overlays.get(walks[0]!.path), walks[0]!.path);
    if (install === 'npm') {
      expect(configuration.mcpServers!.tool!.args![0]).toStartWith('/');
      expect(() => validateLayoutStdio(configuration)).not.toThrow();
    } else {
      const value = command.startsWith('.') ? command : args.at(-1)!;
      expect(() => validateLayoutStdio(configuration)).toThrow('E_HOST_LAYOUT');
      expect(() => validateLayoutStdio(configuration)).toThrow('tool');
      expect(() => validateLayoutStdio(configuration)).toThrow(value);
    }
  });
}

for (const [owner, mode, allowed] of [
  [0, 0o777, false], [0, 0o1777, true],
  [process.geteuid!(), 0o1777, true], [process.geteuid!() + 1, 0o1777, false],
  [process.geteuid!() + 1, 0o755, false],
] as const) {
  test(`R3-4 ancestor uid=${owner} mode=${mode.toString(8)}`, () => {
    const parent = join(dir, 'ancestor'); mkdirSync(parent);
    const original = fs.fstatSync;
    const mocked = spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
      const stat = original(fd);
      return fs.readlinkSync('/proc/self/fd/' + fd) === parent
        ? Object.assign(stat, { uid: owner, mode: (stat.mode & ~0o7777) | mode }) : stat;
    }) as typeof fs.fstatSync);
    try {
      const provision = () => provisionPrivateDirectory(join(parent, 'private'));
      if (allowed) expect(provision).not.toThrow();
      else { expect(provision).toThrow('E_PRIVATE_ANCESTOR'); expect(existsSync(join(parent, 'private'))).toBe(false); }
    } finally { mocked.mockRestore(); }
  });
}

test('R3-9 malformed workspace errors and missing consumers are named', () => {
  for (const workspace of [null, {}]) {
    const configuration = { name: 'Test', agent: { systemPrompt: 'Test' }, modules: { workspace } } as unknown as Recipe;
    expect(() => applyWorkspaceMounts(configuration, layout())).toThrow('E_HOST_LAYOUT: modules.workspace');
  }
  expect(() => validateLayoutConsumers(layout(), [])).toThrow('state consumer local');
});
