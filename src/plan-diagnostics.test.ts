import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let dir: string;
const recipe = { name: 'Diagnostic fixture', agent: { systemPrompt: 'Synthetic only' } };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cook-diagnostics-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function write(name: string, value: unknown) {
  const path = join(dir, name); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value)); return path;
}
function cli(command: string, parent: string, args: string[] = []) {
  return spawnSync(process.execPath, [resolve(import.meta.dir, '../bin/cook'), command, parent,
    '--out', join(dir, 'out'), '--no-prompts', '--yes', ...args], {
    cwd: dir, env: { PATH: process.env.PATH, HOME: dir }, input: '', encoding: 'utf8', timeout: 15000,
  });
}
for (const command of ['install', 'build', 'run']) {
  test(`legacy ${command} names every filename collision with exact guidance`, () => {
    const children = ['a/child.json', 'b/child.json', 'a/other.json', 'b/other.json'];
    for (const name of children) write(name, recipe);
    const parent = write('parent.json', { ...recipe, modules: { fleet: { children: children.map((path, i) => ({ name: `child${i}`, recipe: path })) } } });
    const r = cli(command, parent);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(['child.json', 'other.json'].map(name =>
      `ERR recipe filename collision: ${join(dir, 'a', name)} and ${join(dir, 'b', name)} would both be shipped as recipes/${name}.  Rename one of the files — walked recipes are copied into a single flat directory.\n`,
    ).join(''));
    expect(r.stdout).not.toContain('detecting MCP sources');
  });
  for (const kind of ['services', 'containerTemplateFiles']) test(`legacy ${command} names child and parent for ${kind}`, () => {
    const child = write('nested/child.json', { ...recipe, [kind]: kind === 'services'
      ? [{ name: 'sidecar', image: 'example.invalid/fixture' }]
      : [{ hostPath: 'cfg.conf', inContainer: '/etc/cfg.conf', template: 'x' }] });
    const parent = write('parent.json', { ...recipe, modules: { fleet: { children: [{ name: 'child', recipe: 'nested/child.json' }] } } });
    const r = cli(command, parent); expect(r.status).toBe(2);
    expect(r.stderr).toBe(kind === 'services'
      ? `ERR child recipe ${child} declares services (sidecars), but only the parent recipe's services are deployed.  Move the services declaration to the parent recipe (${parent}).\n`
      : `ERR child recipe ${child} declares containerTemplateFiles, but only the parent recipe's are rendered.  Move them to the parent recipe (${parent}).\n`);
    expect(r.stdout).not.toContain('detecting MCP sources');
  });
  for (const strict of [true, false]) test(`legacy ${command} restores ${strict ? 'strict' : 'non-strict'} detection progress`, () => {
    const parent = write('parent.json', { ...recipe,
      mcpServers: { fixture: { command: 'node', args: ['index.js'], env: { KEY: '${FIXTURE_KEY}' }, source: { url: 'https://example.invalid/mcp.git' } } },
      extensions: { fixture: { kind: 'module', path: 'index.ts', source: { url: 'https://example.invalid/extension.git' } } },
    });
    // Stop after detection, before prompts, pinning or backend effects.
    const r = cli(command, parent, [...(strict ? ['--strict'] : []), '--env-file', join(dir, 'missing.env')]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`-> detecting MCP sources (${strict ? 'strict' : 'non-strict'})\n`);
    expect(r.stdout).toContain('OK detected 2 sources (incl. 1 extension), 1 env var\n');
  });
}
