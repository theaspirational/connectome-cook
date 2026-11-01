import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as childProcess from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as host from './backends/host.js';
import * as docker from './backends/docker.js';
import * as privateFiles from './private-write.js';
import { privateWriteForTest } from './private-write.js';
import { saveSecret, secretFiles, type SecretFiles } from './secret-save.js';

let root: string, config: SecretFiles;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cook-secret-'));
  config = { schema: 'connectome.secret-files/v1', root, files: { provider: 'provider-token' } };
});
afterEach(() => { mock.restore(); rmSync(root, { recursive: true, force: true }); });
const secret = 'synthetic-value-9c38f0-for-output-scan';
function saveWithFaults(options: NonNullable<Parameters<typeof privateWriteForTest>[3]>) {
  const write = spyOn(privateFiles, 'privateWrite').mockImplementation((root, path, value, declared) =>
    privateWriteForTest(root, path, value, { ...declared, ...options }));
  try { return saveSecret(config, 'provider', secret); }
  finally { write.mockRestore(); }
}

test('save returns only adoption/durability metadata and preserves refreshed files and deployment keys', () => {
  writeFileSync(join(root, 'refresh.json'), 'program refreshed');
  writeFileSync(join(root, 'deployment.env'), 'PORT=1234');
  const refresh = statSync(join(root, 'refresh.json'));
  const result = saveSecret(config, 'provider', secret);
  expect(result).toEqual({ saved: true, adoptionRequired: 'restart-or-reload', durability: 'synced' });
  expect(readFileSync(join(root, 'provider-token'), 'utf8')).toBe(secret);
  expect(readFileSync(join(root, 'refresh.json'), 'utf8')).toBe('program refreshed');
  expect(statSync(join(root, 'refresh.json')).ino).toBe(refresh.ino);
  expect(readFileSync(join(root, 'deployment.env'), 'utf8')).toBe('PORT=1234');
});

test('undeclared names, empty values and oversized input cannot replace a file', () => {
  saveSecret(config, 'provider', 'old');
  for (const [name, value] of [['unknown', secret], ['constructor', secret], ['provider', ''], ['provider', 'a'.repeat(65537)]]) {
    expect(() => saveSecret(config, name!, value!)).toThrow('E_SECRET_SAVE');
  }
  expect(readFileSync(join(root, 'provider-token'), 'utf8')).toBe('old');
  expect(readdirSync(root)).toEqual(['provider-token']);
});

for (const invalid of [
  null, {}, { schema: 'other', root: '/tmp/private', files: { key: 'token' } },
  { schema: 'connectome.secret-files/v1', root: '/tmp/private', files: { key: '../outside' } },
  { schema: 'connectome.secret-files/v1', root: '/tmp/private', files: { key: '/outside' } },
  { schema: 'connectome.secret-files/v1', root: '/tmp/private', files: { key: 'bad\0file' } },
  { schema: 'connectome.secret-files/v1', root: 'relative', files: { key: 'token' } },
  { schema: 'connectome.secret-files/v1', root: '/tmp/../private', files: { key: 'token' } },
  { schema: 'connectome.secret-files/v1', root: '/tmp/private', files: { one: 'token', two: 'token' } },
  { schema: 'connectome.secret-files/v1', root: '/tmp/private', files: { one: 'token', two: 'token/key' } },
  { schema: 'connectome.secret-files/v1', root: '/tmp/private', files: {}, value: secret },
]) {
  test('invalid secret-file declaration is refused without echoing its contents', () => {
    let error = '';
    try { secretFiles(invalid); } catch (e) { error = String(e); }
    expect(error).toBe('Error: E_SECRET_SAVE'); expect(error).not.toContain(secret);
  });
}

test('output scan: stdout, stderr, console, results and thrown errors contain no value', () => {
  const output: string[] = [];
  spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { output.push(String(chunk)); return true; });
  spyOn(process.stderr, 'write').mockImplementation((chunk: any) => { output.push(String(chunk)); return true; });
  for (const method of ['log', 'error', 'warn', 'info', 'debug', 'trace'] as const) {
    spyOn(console, method).mockImplementation((...args) => { output.push(args.map(String).join(' ')); });
  }
  const results: unknown[] = [saveSecret(config, 'provider', secret)];
  const errors: string[] = [];
  const operations = [
    () => saveSecret(config, secret, secret),
    () => saveSecret({ ...config, files: { provider: secret + '\0' } }, 'provider', secret),
    () => saveWithFaults({ test: { point: () => { throw new Error(secret); } } }),
    () => privateWriteForTest(root, 'provider-token', secret, { test: { point: () => { throw new Error(secret); } } }),
    () => saveSecret({ ...config, root: join(root, secret) }, 'provider', secret),
  ];
  for (const operation of operations) {
    try { results.push(operation()); }
    catch (e) { errors.push(String(e), (e as Error).stack ?? '', JSON.stringify(e)); }
  }
  mock.restore();
  expect(errors.length).toBe(15);
  expect(output).toEqual([]);
  expect([...output, ...errors, JSON.stringify(results)].join('\n')).not.toContain(secret);
});

test('save and refusal have zero fetch, build, spawn or service effects', () => {
  const spies = [spyOn(globalThis, 'fetch'), spyOn(host, 'runHostBackend'), spyOn(docker, 'runDockerBackend'),
    spyOn(childProcess, 'spawn'), spyOn(childProcess, 'spawnSync'), spyOn(childProcess, 'exec'),
    spyOn(childProcess, 'execSync'), spyOn(childProcess, 'execFile'), spyOn(childProcess, 'execFileSync'),
    spyOn(childProcess, 'fork'), spyOn(Bun, 'spawn'), spyOn(Bun, 'spawnSync')];
  // Fail closed if a regression attempts any effect, rather than execute it.
  for (const spy of spies) spy.mockImplementation((() => { throw new Error('forbidden effect'); }) as any);
  saveSecret(config, 'provider', secret);
  expect(() => saveSecret(config, 'unknown', secret)).toThrow();
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

function cli(args: string[], input = secret) {
  return spawnSync(process.execPath, [resolve('bin/cook'), 'secret', ...args], {
    input, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
}
function configFile(): string {
  const path = join(root, 'destinations.json'); writeFileSync(path, JSON.stringify(config)); return path;
}

test('real CLI saves stdin bytes without echoing them and requires explicit adoption', () => {
  const p = cli(['save', '--config', configFile(), '--name', 'provider']);
  expect(p.status).toBe(0); expect(p.stderr).toBe('');
  expect(JSON.parse(p.stdout)).toEqual({ saved: true, adoptionRequired: 'restart-or-reload', durability: 'synced' });
  expect(p.stdout + p.stderr).not.toContain(secret);
  expect(readFileSync(join(root, 'provider-token'), 'utf8')).toBe(secret);
});

test('CLI mode repair is explicit, and refused input/errors do not echo secrets', () => {
  const path = configFile();
  writeFileSync(join(root, 'provider-token'), 'old', { mode: 0o644 });
  for (const [index, args] of [
    ['save', '--config', path, '--name', 'provider'],
    ['save', '--config', path, '--name', secret],
    ['save', '--config', secret, '--name', 'provider'],
    ['save', '--config', path, '--name', 'provider', '--value', secret],
  ].entries()) {
    const p = cli(args);
    expect(p.status).toBe(2); expect(p.stdout).toBe('');
    const detail = index === 0 ? ' (E_PRIVATE_MODE)' : '';
    expect(p.stderr).toBe(`E_SECRET_SAVE${detail}: secret save refused.\n`);
    expect(p.stdout + p.stderr).not.toContain(secret);
    expect(readFileSync(join(root, 'provider-token'), 'utf8')).toBe('old');
  }
  const p = cli(['save', '--config', path, '--name', 'provider', '--allow-tightening']);
  expect(p.status).toBe(0); expect(statSync(join(root, 'provider-token')).mode & 0o7777).toBe(0o600);
  expect(p.stdout + p.stderr).not.toContain(secret);
});

test('CLI rejects invalid JSON, oversized stdin and empty stdin without leaking values', () => {
  const path = configFile();
  for (const input of ['', secret.repeat(3000)]) {
    const p = cli(['save', '--config', path, '--name', 'provider'], input);
    expect(p.status).toBe(2); expect(p.stdout + p.stderr).not.toContain(secret);
  }
  writeFileSync(path, `{invalid ${secret}`);
  const p = cli(['save', '--config', path, '--name', 'provider']);
  expect(p.status).toBe(2); expect(p.stdout + p.stderr).not.toContain(secret);
  expect(readdirSync(root)).toEqual(['destinations.json']);
});

for (const code of ['E_PRIVATE_PATH', 'E_PRIVATE_MODE', 'E_PRIVATE_IO'] as const) {
  test(`API and CLI surface ${code} without paths, names or values`, () => {
    if (code === 'E_PRIVATE_PATH') config.files.provider = '../' + secret;
    if (code === 'E_PRIVATE_MODE') writeFileSync(join(root, 'provider-token'), 'old', { mode: 0o644 });
    if (code === 'E_PRIVATE_IO') config.files.provider = 'missing/' + secret;
    let error: unknown;
    try { saveSecret(config, 'provider', secret); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error);
    expect((error as { code: string }).code).toBe(code);
    expect(JSON.stringify(error) + String(error)).not.toContain(secret);
    const p = cli(['save', '--config', configFile(), '--name', 'provider']);
    expect(p.status).toBe(2); expect(p.stdout).toBe('');
    expect(p.stderr).toBe(`E_SECRET_SAVE (${code}): secret save refused.\n`);
    expect(p.stdout + p.stderr).not.toContain(secret);
    expect(p.stdout + p.stderr).not.toContain(root);
  });
}

test('bare secret subcommand prints usage without changing top-level help', () => {
  const p = cli([]), help = cli(['--help']);
  expect(p.status).toBe(2); expect(p.stderr).toBe('');
  expect(p.stdout).toBe(help.stdout);
  expect(p.stdout).toContain('cook secret save --config');
});
