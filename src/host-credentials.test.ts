import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { credentialBindings, credentialSecretFiles, renderCredentialAdapter, validateCredentialConsumers, type CredentialBindings } from './host-credentials.js';
import { provisionSecretFiles, saveSecret } from './secret-save.js';

let dir: string, c: CredentialBindings, adapter: string, node: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cook-credentials-'));
  c = { schema: 'connectome.credential-bindings/v1', root: join(dir, 'credentials'), files: { token: 'provider/token' }, consumers: { local: { API_TOKEN: 'token' } } };
  node = Bun.which('node')!;
  provisionSecretFiles(credentialSecretFiles(c));
  const consumer = join(dir, 'consumer.mjs');
  writeFileSync(consumer, "process.stdout.write(JSON.stringify({ value: process.env.API_TOKEN, args: process.argv.slice(2), unbound: process.env.OTHER_TOKEN }));");
  adapter = join(dir, 'adapter.mjs');
  writeFileSync(adapter, renderCredentialAdapter(c, 'local', node, [consumer, 'public-argument']));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const tokenPath = () => join(c.root, c.files.token!);
const launch = () => spawnSync(node, [adapter], { encoding: 'utf8', env: { PATH: process.env.PATH } });

test('named adapter loads exact file bytes only into child env, not source or argv, and reloads on launch', () => {
  for (const value of ['synthetic-secret\nwith-newline', 'rotated-synthetic-secret']) {
    saveSecret(credentialSecretFiles(c), 'token', value);
    const result = launch(); expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ value, args: ['public-argument'] });
    expect(result.stderr).toBe('');
    expect(readFileSync(adapter, 'utf8')).not.toContain(value);
    expect(JSON.stringify(c)).not.toContain(value);
    expect(process.env.API_TOKEN).toBeUndefined();
  }
  chmodSync(tokenPath(), 0o400);
  expect(launch().status).toBe(0);
});
test('absent, unsafe, empty, oversized, invalid UTF-8 and NUL files refuse with fixed redacted output', () => {
  const refuses = () => {
    const result = launch();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('E_CREDENTIAL_LAUNCH: credential consumer refused.\n');
  };
  refuses();
  for (const value of ['', 'x'.repeat(65537), 'synthetic-secret\0', Buffer.from([0xff])]) {
    writeFileSync(tokenPath(), value, { mode: 0o600 }); refuses();
  }
  writeFileSync(tokenPath(), 'synthetic-secret'); chmodSync(tokenPath(), 0o644); refuses();
  chmodSync(tokenPath(), 0o600);
  const alias = join(dir, 'alias'); linkSync(tokenPath(), alias); refuses(); unlinkSync(alias);
  unlinkSync(tokenPath()); symlinkSync(alias, tokenPath()); refuses();
  unlinkSync(tokenPath()); mkdirSync(tokenPath()); refuses(); rmSync(tokenPath(), { recursive: true });
  execFileSync('mkfifo', [tokenPath()]); refuses(); unlinkSync(tokenPath());
  writeFileSync(tokenPath(), 'synthetic-secret', { mode: 0o600 });
  chmodSync(join(c.root, 'provider'), 0o755); refuses(); chmodSync(join(c.root, 'provider'), 0o700);
  chmodSync(c.root, 0o755); refuses(); chmodSync(c.root, 0o700);
  // A linked ancestor is rejected, even when its target is private and owned.
  const real = join(dir, 'real-provider');
  rmSync(join(c.root, 'provider'), { recursive: true }); mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, join(c.root, 'provider')); refuses();
});
test('declarations refuse values, unsafe names, paths, consumers, duplicate env and root overlap', () => {
  for (const patch of [
    { value: 'synthetic-secret' }, { root: 'relative' }, { files: { token: '../escape' } },
    { consumers: {} }, { consumers: { '../local': { TOKEN: 'token' } } },
    { consumers: { local: { TOKEN: 'missing' } } },
    ...['BAD-NAME', 'PATH', 'NODE_OPTIONS', 'BASH_ENV', 'LD_PRELOAD'].map(env => ({ consumers: { local: { [env]: 'token' } } })),
  ]) expect(() => credentialBindings({ ...c, ...patch })).toThrow('E_CREDENTIAL_BINDINGS');
  const recipe = { name: 'Test', agent: { systemPrompt: 'Test' }, mcpServers: { local: { command: node } } };
  for (const server of [undefined, { url: 'ws://localhost/' }, { command: 'python3' }, { command: node, token: 'not-file-backed' }, { command: node, env: { API_TOKEN: 'conflict' } }]) {
    expect(() => validateCredentialConsumers(c, [{ ...recipe, mcpServers: server ? { local: server } : {} }], join(dir, 'runtime'))).toThrow('E_CREDENTIAL_BINDINGS');
  }
  expect(() => validateCredentialConsumers(c, [recipe], c.root)).toThrow('E_CREDENTIAL_BINDINGS');
  expect(() => validateCredentialConsumers(c, [recipe], join(dir, 'runtime'), join(dir, 'different'))).toThrow('E_CREDENTIAL_BINDINGS');
  expect(() => renderCredentialAdapter(c, 'missing', node, [])).toThrow('E_CREDENTIAL_BINDINGS');
  expect(() => renderCredentialAdapter(c, 'local', 'node', [])).toThrow('E_CREDENTIAL_BINDINGS');
});
test('secret provision CLI creates private roots/parents without values or stdin and refuses unsafe destinations', () => {
  const config = join(dir, 'secret-files.json');
  const fresh = { ...credentialSecretFiles(c), root: join(dir, 'fresh') };
  writeFileSync(config, JSON.stringify(fresh));
  const cli = (args: string[]) => spawnSync(process.execPath, [resolve('bin/cook'), 'secret', ...args], { encoding: 'utf8' });
  const result = cli(['provision', '--config', config]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ provisioned: true });
  expect(existsSync(join(fresh.root, 'provider'))).toBe(true);
  expect(existsSync(join(fresh.root, 'provider/token'))).toBe(false);
  expect(cli(['provision', '--config', config, '--name', 'token']).status).toBe(2);
  chmodSync(fresh.root, 0o755);
  expect(cli(['provision', '--config', config]).stderr).toContain('E_PRIVATE_MODE');
  chmodSync(fresh.root, 0o700);
  if (process.geteuid!() !== 0) expect(() => provisionSecretFiles({ ...fresh, root: '/tmp', files: { token: 'cook-probe-never-written' } })).toThrow();
});

test('failed consumer execution is redacted and does not echo loaded values', () => {
  saveSecret(credentialSecretFiles(c), 'token', 'synthetic-secret');
  writeFileSync(adapter, renderCredentialAdapter(c, 'local', '/nonexistent/consumer', []));
  const result = launch();
  expect(result.status).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('E_CREDENTIAL_LAUNCH: credential consumer refused.\n');
});

test('credential environment denylist covers module, TLS, proxy and SSH controls in any case', () => {
  for (const env of ['NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_DEBUG', 'BUN_INSTALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTPS_PROXY', 'https_proxy', 'HtTpS_pRoXy', 'ALL_PROXY', 'NO_PROXY', 'GIT_SSH', 'GIT_SSH_COMMAND',
    'git_ssh_variant', 'node_path', 'bun_install', 'ssl_cert_dir']) {
    expect(() => credentialBindings({ ...c, consumers: { local: { [env]: 'token' } } })).toThrow('E_CREDENTIAL_BINDINGS');
  }
});
