import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertCredentialFreeSourceUrl } from './source-url.js';

const CLI = resolve(import.meta.dir, '../bin/cook');
const SECRET = 'synthetic-acquisition-secret';
const SHA = 'a'.repeat(40);
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cook-acquisition-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // Record argv and persist clone URLs just as git would. No network access.
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'git-argv'))}, JSON.stringify(args) + '\\n');
appendFileSync(${JSON.stringify(join(dir, 'git-env'))}, JSON.stringify({ args, env: process.env }) + '\\n');
const behavior = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'git-behavior.json'))}, 'utf-8'));
if (args[0] === 'ls-remote') {
  if (args[1] === behavior.missing) process.exit(1);
  if (args[1] === behavior.empty) process.exit(0);
  console.log('${SHA}\\t' + args[2]);
} else if (args[0] === 'clone') {
  mkdirSync(join(args[2], '.git'), { recursive: true });
  writeFileSync(join(args[2], '.git/config'), '[remote "origin"]\\nurl = ' + args[1]);
} else if (args[0] === 'rev-parse') {
  console.log('${SHA}');
}
`, { mode: 0o755 });
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\n/usr/bin/env > install-env.txt\n', { mode: 0o755 });
  env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    TMPDIR: dir,
    COOK_TEST_SECRET: SECRET,
    ANTHROPIC_API_KEY: SECRET,
    GIT_TOKEN: SECRET,
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(command: string, source: Record<string, unknown> | undefined, flags: string[] = [], extension = false) {
  writeFileSync(join(dir, 'git-behavior.json'), JSON.stringify({
    missing: env.FAKE_MISSING_URL, empty: env.FAKE_EMPTY_URL,
  }));
  const recipe = join(dir, 'recipe.json');
  writeFileSync(recipe, JSON.stringify({
    name: 'Security fixture',
    agent: { systemPrompt: 'test' },
    requirements: { sdk: { exposeAs: 'SDK_ROOT', probe: [dir] } },
    ...(source ? extension
      ? { extensions: { fixture: { kind: 'module', path: './index.ts', source } } }
      : { mcpServers: { fixture: { command: 'node', args: ['index.js'], source } } }
      : {}),
  }));
  return spawnSync(process.execPath, [CLI, command, recipe, '--no-prompts', '--yes', '--out', join(dir, 'out'), ...flags], {
    env, encoding: 'utf-8',
  });
}

function gitCalls(): string {
  const path = join(dir, 'git-argv');
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

for (const command of ['build', 'install']) {
  for (const missing of ['component', 'host']) {
    test(`${command}: unresolved ${missing} pin refuses before materialization`, () => {
      env.FAKE_MISSING_URL = missing === 'component'
        ? 'https://example.invalid/component.git'
        : 'https://github.com/anima-research/connectome-host.git';
      const result = run(command, { url: 'https://example.invalid/component.git' }, ['--pin-refs']);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('could not resolve');
      expect(existsSync(join(dir, 'out'))).toBe(false);
      expect(gitCalls()).not.toContain('clone');
    });
  }

  for (const extension of [false, true]) {
    test(`${command}: credentialed ${extension ? 'extension' : 'MCP'} URLs never reach git or artifacts`, () => {
      const result = run(command, { url: `https://user:${SECRET}@example.invalid/repo.git` }, ['--pin-refs'], extension);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain(SECRET);
      expect(result.stdout + result.stderr).toContain('credentials');
      expect(result.stdout + result.stderr).toContain(
        `${join(dir, 'recipe.json')} :: ${extension ? 'extensions' : 'mcpServers'}.fixture.source.url`,
      );
      expect(gitCalls()).toBe('');
      expect(existsSync(join(dir, 'out'))).toBe(false);
    });
  }
}

test('credentialed connectome-host URL is rejected before pinning', () => {
  const result = run('install', undefined, ['--pin-refs', '--ch-repo', `https://user:${SECRET}@example.invalid/host.git`]);
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).not.toContain(SECRET);
  expect(gitCalls()).toBe('');
  expect(result.stdout + result.stderr).toContain('--ch-repo');
  expect(existsSync(join(dir, 'out'))).toBe(false);
});

test('host authSecret is refused before any clone or lock write', () => {
  const result = run('install', { url: 'https://example.invalid/private.git', authSecret: 'GIT_TOKEN' });
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('authSecret');
  expect(result.stdout + result.stderr).not.toContain(SECRET);
  expect(gitCalls()).toBe('');
  expect(existsSync(join(dir, 'out'))).toBe(false);
});

test('private symbolic pins cannot silently fall back to unpinned builds', () => {
  const result = run('build', { url: 'https://example.invalid/private.git', authSecret: 'GIT_TOKEN' }, ['--pin-refs']);
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).not.toContain(SECRET);
  expect(existsSync(join(dir, 'out'))).toBe(false);
  expect(gitCalls()).toBe('');
});

for (const pin of [false, true]) {
  test(`public clones keep clean remotes and filter build environments (pin=${pin})`, () => {
    const envFile = join(dir, 'build.env');
    writeFileSync(envFile, `SDK_ROOT=${dir}/declared-sdk\nUNDECLARED_SECRET=${SECRET}\n`);
    env.SDK_ROOT = '/parent-sdk';
    const result = run('install', {
      url: 'https://example.invalid/component.git',
      install: { run: '/usr/bin/env > custom-env.txt', runtime: 'custom' },
    }, ['--env-file', envFile, ...(pin ? ['--pin-refs'] : [])]);
    expect(result.status).toBe(0);
    const out = join(dir, 'out');
    for (const path of ['app/install-env.txt', 'component/custom-env.txt']) {
      const contents = readFileSync(join(out, path), 'utf-8');
      expect(contents).not.toContain(SECRET);
      expect(contents).not.toContain('GIT_TOKEN=');
      expect(contents).toContain(`SDK_ROOT=${dir}/declared-sdk\n`);
      expect(contents).toContain(`PATH=${env.PATH}\n`);
    }
    const lock = readFileSync(join(out, 'connectome.lock'), 'utf-8');
    const remotes = ['app', 'component'].map((path) => readFileSync(join(out, path, '.git/config'), 'utf-8')).join('\n');
    expect(lock).toContain(SHA);
    expect(remotes).toContain('url = https://example.invalid/component.git');
    expect(gitCalls() + result.stdout + result.stderr + lock + remotes).not.toContain(SECRET);
  });
}

test('URL checks allow public transports and reject credential-bearing forms without echoing them', () => {
  for (const url of [
    'https://example.invalid/repo.git', 'http://example.invalid/repo.git',
    'ssh://git@example.invalid/repo.git', 'git@example.invalid:repo.git',
    'file:///tmp/repo', '/tmp/repo',
    'https://user@example.invalid/repo.git',
  ]) {
    expect(() => assertCredentialFreeSourceUrl(url)).not.toThrow();
  }
  for (const url of [
    `https://${SECRET}:@example.invalid/repo.git`,
    `https://user%3A${SECRET}@example.invalid/repo.git`,
    `oauth2:${SECRET}@example.invalid:repo.git`,
    `ssh://git:${SECRET}@example.invalid/repo.git`,
    `https://${SECRET}@`,
  ]) {
    expect(() => assertCredentialFreeSourceUrl(url)).toThrow('credentials');
    try {
      assertCredentialFreeSourceUrl(url);
    } catch (err) {
      expect(String(err)).not.toContain(SECRET);
    }
  }
});

for (const command of ['build', 'install']) {
  test(`${command}: an unknown ref leaves existing output untouched`, () => {
    env.FAKE_EMPTY_URL = 'https://example.invalid/component.git';
    const out = join(dir, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'connectome.lock'), 'existing lock');
    const result = run(command, { url: env.FAKE_EMPTY_URL, ref: 'missing' }, ['--pin-refs']);
    expect(result.status).not.toBe(0);
    expect(gitCalls()).not.toContain('clone');
    expect(readFileSync(join(out, 'connectome.lock'), 'utf-8')).toBe('existing lock');
    expect(existsSync(join(out, 'recipes'))).toBe(false);
  });
}

function gitEnvironments(): Array<{ args: string[]; env: Record<string, string> }> {
  return readFileSync(join(dir, 'git-env'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
}

function buildEnvFile(path: string): Record<string, string> {
  return Object.fromEntries(readFileSync(path, 'utf-8').trim().split('\n').map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }).filter(([key]) => !['PWD', 'SHLVL', '_'].includes(key!)));
}

test('pin resolution, clone and builds share the documented process allowlist', () => {
  const allowed = {
    PATH: env.PATH!, HOME: dir, TMPDIR: dir,
    LANG: 'C', LC_ALL: 'C', TERM: 'dumb', CI: 'true',
    HTTP_PROXY: 'http://proxy.invalid:8080', HTTPS_PROXY: 'http://proxy.invalid:8081',
    NO_PROXY: 'localhost', ALL_PROXY: 'socks5://proxy.invalid:1080',
    http_proxy: 'http://proxy.invalid:8082', https_proxy: 'http://proxy.invalid:8083',
    no_proxy: '127.0.0.1', all_proxy: 'socks5://proxy.invalid:1081',
    NODE_EXTRA_CA_CERTS: '/dev/null', SSL_CERT_FILE: '/dev/null', SSL_CERT_DIR: dir,
  };
  Object.assign(env, allowed, { PIP_INDEX_URL: SECRET, npm_config_registry: SECRET });
  const result = run('install', {
    url: 'https://example.invalid/component.git',
    install: { run: '/usr/bin/env > custom-env.txt', runtime: 'custom' },
  }, ['--pin-refs']);
  expect(result.status).toBe(0);
  const expected = { ...allowed, SDK_ROOT: dir };
  const installs = gitEnvironments();
  expect(installs.filter(({ args }) => args[0] === 'clone')).toHaveLength(2);
  expect(installs.filter(({ args }) => args[0] === 'ls-remote')).toHaveLength(2);
  for (const call of installs) {
    // Requirements are host materialization inputs, not parent process settings.
    expect(call.env).toEqual(call.args[0] === 'ls-remote' ? allowed : expected);
  }
  for (const path of ['app/install-env.txt', 'component/custom-env.txt']) {
    expect(buildEnvFile(join(dir, 'out', path))).toEqual(expected);
  }
});

test('pin resolution and clone receive Git configuration and authentication, but builds do not', () => {
  const auth = {
    SSH_AUTH_SOCK: '/synthetic/ssh.sock', GIT_SSH: '/synthetic/ssh',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GIT_SSH_VARIANT: 'ssh',
    GIT_ASKPASS: '/synthetic/git-askpass', SSH_ASKPASS: '/synthetic/ssh-askpass',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: join(dir, 'global.gitconfig'),
    GIT_CONFIG_SYSTEM: join(dir, 'system.gitconfig'), XDG_CONFIG_HOME: join(dir, 'xdg'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.proxy',
    GIT_CONFIG_VALUE_0: 'http://proxy.invalid:8080',
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '/synthetic/helper',
  };
  Object.assign(env, auth, {
    GIT_CONFIG_KEY_2: 'unused', GIT_CONFIG_VALUE_2: SECRET, GIT_CONFIG_PARAMETERS: SECRET,
  });
  const result = run('install', {
    url: 'https://example.invalid/component.git', ref: 'refs/pull/1/head',
    install: { run: '/usr/bin/env > custom-env.txt', runtime: 'custom' },
  }, ['--pin-refs']);
  expect(result.status).toBe(0);
  const builds = buildEnvFile(join(dir, 'out/component/custom-env.txt'));
  for (const key of Object.keys(auth)) expect(builds[key]).toBeUndefined();
  const calls = gitEnvironments();
  expect(calls.some(({ args }) => args[0] === 'fetch')).toBe(true);
  expect(calls.some(({ args }) => args[0] === 'checkout')).toBe(true);
  expect(calls.filter(({ args }) => args[0] === 'ls-remote')).toHaveLength(2);
  const { SDK_ROOT: _requirement, ...processSettings } = builds;
  for (const call of calls) {
    const shared = call.args[0] === 'ls-remote' ? processSettings : builds;
    expect(call.env).toEqual({ ...shared, ...auth });
    expect(call.env.GIT_CONFIG_VALUE_2).toBeUndefined();
    expect(call.env.GIT_CONFIG_PARAMETERS).toBeUndefined();
  }
});

for (const extension of [false, true]) {
  test(`credential-like query parameters report the ${extension ? 'extension' : 'MCP'} location safely`, () => {
    const result = run('build', { url: `https://user@example.invalid/repo.git?access_token=${SECRET}` }, [], extension);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      `${join(dir, 'recipe.json')} :: ${extension ? 'extensions' : 'mcpServers'}.fixture.source.url`,
    );
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(result.stdout + result.stderr).not.toContain('https://');
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });
}

test('bare HTTPS usernames survive a host install with the expected path', () => {
  const url = 'https://user@example.invalid/component.git';
  const result = run('install', { url });
  expect(result.status).toBe(0);
  expect(gitCalls()).toContain(url);
  expect(readFileSync(join(dir, 'out/component/.git/config'), 'utf-8')).toContain(url);
});

test('all query strings and fragments are rejected before path derivation', () => {
  for (const name of ['token', 'access_token', 'password', 'secret', 'key', 'auth', 'sig',
    'apiKey', 'Authorization', 'x-amz-signature', 'client_secret', '%74oken', 'pat', 'ref', 'depth']) {
    expect(() => assertCredentialFreeSourceUrl(`https://example.invalid/repo.git?${name}=${SECRET}`))
      .toThrow('query strings and fragments');
  }
  for (const url of ['https://example.invalid/repo.git', 'git@example.invalid:repo.git', '/tmp/repo', './repo']) {
    for (const suffix of ['?', '?x', '#', '#readme']) {
      expect(() => assertCredentialFreeSourceUrl(`${url}${suffix}`))
        .toThrow('query strings and fragments');
    }
  }
});

test('malformed percent-encoding in userinfo reports an invalid source URL', () => {
  expect(() => assertCredentialFreeSourceUrl('https://user%name@host/repo.git'))
    .toThrow('Source URL: invalid source URL; use a URL without embedded credentials.');
});

const TOKEN_USERNAMES = [
  ...['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-'].map((prefix) => `${prefix}${SECRET}`),
  'oauth2', 'x-access-token', 'x-token-auth',
];

test('known token-shaped usernames are rejected, including percent-encoded forms', () => {
  for (const username of TOKEN_USERNAMES) {
    for (const encoded of [username, `%${username.charCodeAt(0).toString(16)}${username.slice(1)}`]) {
      expect(() => assertCredentialFreeSourceUrl(`https://${encoded}@example.invalid/repo.git`))
        .toThrow('credentials');
    }
  }
});

for (const command of ['build', 'install']) {
  test(`${command}: token-shaped usernames never reach logs, git or artifacts`, () => {
    const result = run(command, { url: `https://ghp_${SECRET}@example.invalid/repo.git` }, ['--pin-refs']);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(result.stdout + result.stderr).toContain('mcpServers.fixture.source.url');
    expect(gitCalls()).toBe('');
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });

  test(`${command}: query and fragment URLs cannot materialize malformed paths`, () => {
    for (const url of ['https://example.invalid/repo.git', 'git@example.invalid:repo.git', '/tmp/repo', './repo']) {
      for (const suffix of ['?ref=main&depth=1', '#readme']) {
        const result = run(command, { url: `${url}${suffix}` });
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).toContain('query strings and fragments');
        expect(gitCalls()).toBe('');
        expect(existsSync(join(dir, 'out'))).toBe(false);
      }
    }
  });
}
