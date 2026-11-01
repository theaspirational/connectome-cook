import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hostLayout, provisionLayout, validateLayoutConsumers, type HostLayout } from './host-layout.js';
import { provisionPrivateDirectory } from './private-directory.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cook-layout-')); });
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
