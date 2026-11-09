import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
if (behavior.fail && args[0] === behavior.fail && process.env.GIT_CONFIG_COUNT === '1') { console.log(process.env.GIT_CONFIG_VALUE_0); console.error(process.env.GIT_CONFIG_VALUE_0); process.exit(128); }
const sslBypass = args[0] === '-c' && args[1] === 'http.sslVerify=false';
if (sslBypass) args.splice(0, 2);
if (args[0] === 'ls-remote') {
  if (behavior.requireSsl && args[1] === behavior.requireSsl && !sslBypass) process.exit(1);
  if (args[1] === behavior.missing) { console.error('old diagnostic 1\\nold diagnostic 2\\nfatal: TLS handshake failed\\ncheck the custom CA\\nremote unavailable'); process.exit(1); }
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
    fail: env.FAKE_FAIL_GIT, missing: env.FAKE_MISSING_URL, empty: env.FAKE_EMPTY_URL, requireSsl: env.FAKE_REQUIRE_SSL,
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

for (const pin of [false, true]) {
  test(`R1-1: private host acquisition uses only an origin-scoped environment header (pin=${pin})`, () => {
    env.ANTHROPIC_API_KEY = 'runtime-only-key';
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '/synthetic/helper',
    });
    const result = run('install', {
      url: 'https://example.invalid/private.git', authSecret: 'GIT_TOKEN', ref: 'refs/pull/1/head',
      install: { run: '/usr/bin/env > custom-env.txt', runtime: 'custom' },
    }, pin ? ['--pin-refs'] : []);
    expect(result.status).toBe(0);
    const header = `Authorization: Basic ${Buffer.from(`oauth2:${SECRET}`).toString('base64')}`;
    const calls = gitEnvironments();
    for (const command of ['clone', 'fetch', 'checkout', 'rev-parse', ...(pin ? ['ls-remote'] : [])]) {
      expect(calls.some(call => call.args[0] === command && call.env.GIT_CONFIG_COUNT === '2')).toBe(true);
    }
    for (const call of calls) {
      expect(call.env.GIT_CONFIG_KEY_0).toBe('credential.helper');
      expect(call.env.GIT_CONFIG_VALUE_0).toBe('/synthetic/helper');
      expect(call.env.GIT_TOKEN).toBeUndefined();
      if (call.env.GIT_CONFIG_COUNT === '2') {
        expect(call.env.GIT_CONFIG_KEY_1).toBe('http.https://example.invalid/.extraHeader');
        expect(call.env.GIT_CONFIG_VALUE_1).toBe(header);
      } else {
        expect(call.env.GIT_CONFIG_VALUE_1).toBeUndefined();
      }
    }
    const files = (path: string): string[] => readdirSync(path, { withFileTypes: true })
      .flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : join(path, entry.name) === join(dir, 'out/.env') ? [] : [readFileSync(join(path, entry.name), 'utf-8')]);
    expect(readFileSync(join(dir, 'out/.env'), 'utf-8')).toContain(`GIT_TOKEN='${SECRET}'`);
    const persisted = files(join(dir, 'out')).join('\n');
    for (const secret of [SECRET, header]) {
      expect(gitCalls() + result.stdout + result.stderr + persisted).not.toContain(secret);
    }
  });
}

test('R1-1: private symbolic Docker pins use the same environment-only channel', () => {
  const result = run('build', { url: 'https://example.invalid/private.git', authSecret: 'GIT_TOKEN' }, ['--pin-refs']);
  expect(result.status).toBe(0);
  expect(gitEnvironments().find(call => call.args[1]?.includes('private.git'))?.env.GIT_CONFIG_COUNT).toBe('1');
  expect(gitCalls() + result.stdout + result.stderr + readFileSync(join(dir, 'out/connectome.lock'), 'utf-8')).not.toContain(SECRET);
});

for (const declaration of ['source only', 'runtime env', 'requirement'] as const) {
  test(`R5: authSecret keeps main runtime artifacts and explicit parent build opt-in (${declaration})`, () => {
    const token = 'synthetic-shared-github-token';
    env.GITHUB_TOKEN = token;
    env.COOK_PASS_ENV = 'GITHUB_TOKEN';
    const recipe = join(dir, 'shared.json');
    writeFileSync(join(dir, 'git-behavior.json'), '{}');
    writeFileSync(recipe, JSON.stringify({
      name: 'Shared GitHub credential', agent: { systemPrompt: 'test' },
      ...(declaration === 'requirement'
        ? { requirements: { github: { exposeAs: 'GITHUB_TOKEN' } } } : {}),
      mcpServers: { github: { command: 'node',
        ...(declaration === 'runtime env' ? { env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } } : {}),
        source: { url: 'https://example.invalid/private.git', ref: 'refs/pull/1/head', authSecret: 'GITHUB_TOKEN',
          install: { run: '/usr/bin/env > custom-env.txt', runtime: 'custom' },
        },
      } },
    }));
    const out = join(dir, 'out');
    const result = spawnSync(process.execPath, [CLI, 'install', recipe,
      '--out', out, '--yes', '--no-prompts', '--pin-refs'], { env, encoding: 'utf-8' });
    expect(result.status).toBe(0);
    for (const path of ['app/install-env.txt', 'private/custom-env.txt']) {
      expect(buildEnvFile(join(out, path)).GITHUB_TOKEN).toBe(token);
    }
    const header = `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
    const privateCalls = gitEnvironments().filter(call => call.env.GIT_CONFIG_VALUE_0 === header);
    for (const command of ['ls-remote', 'clone', 'fetch', 'checkout', 'rev-parse']) {
      expect(privateCalls.some(call => call.args[0] === command)).toBe(true);
    }
    // Runtime .env and requirement values match main, independently of Git auth.
    const artifacts = (path: string): string[] => readdirSync(path, { withFileTypes: true })
      .flatMap(entry => entry.isDirectory() ? artifacts(join(path, entry.name))
        : /^(install-env|custom-env)\.txt$/.test(entry.name) || join(path, entry.name) === join(out, '.env') || (declaration === 'requirement' && join(path, entry.name) === join(out, 'connectome.lock')) ? [] : [readFileSync(join(path, entry.name), 'utf-8')]);
    for (const secret of [token, header]) {
      expect(gitCalls() + result.stdout + result.stderr + artifacts(out).join('\n')).not.toContain(secret);
    }
    const runtimeEnv = readFileSync(join(out, '.env'), 'utf-8');
    expect(runtimeEnv).not.toContain(header);
    expect(runtimeEnv).toContain(`GITHUB_TOKEN='${token}'`);
    expect(statSync(join(out, '.env')).mode & 0o777).toBe(0o600);
    const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf-8'));
    if (declaration === 'requirement') expect(lock.requirements[0].value).toBe(token);
    else expect(JSON.stringify(lock)).not.toContain(token);
    if (declaration === 'runtime env') {
      const emitted = JSON.parse(readFileSync(join(out, 'recipes/shared.json'), 'utf-8'));
      expect(emitted.mcpServers.github.env.GITHUB_TOKEN).toBe('${GITHUB_TOKEN}');
    }
    // A later launch works without the original operator shell/token.
    writeFileSync(join(dir, 'bin/bun'), `#!/bin/sh\n[ "$GITHUB_TOKEN" = '${token}' ]\n`, { mode: 0o755 });
    const launched = spawnSync(join(out, 'run.sh'), [], {
      env: { PATH: env.PATH, HOME: dir }, encoding: 'utf-8',
    });
    expect(launched.status).toBe(0);
    expect(launched.stdout + launched.stderr).not.toContain(token);
  });
}

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
      expect(contents).not.toContain('SDK_ROOT=');
      expect(contents).not.toContain(`${dir}/declared-sdk`);
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
    PIP_INDEX_URL: 'https://mirror.invalid/pip', npm_config_registry: 'https://mirror.invalid/npm',
  };
  Object.assign(env, allowed, {
    PIP_UNDECLARED_SECRET: SECRET, npm_config_undeclared_secret: SECRET,
    UV_UNDECLARED_SECRET: SECRET, CARGO_UNDECLARED_SECRET: SECRET,
    RUSTUP_UNDECLARED_SECRET: SECRET, LC_UNDECLARED_SECRET: SECRET,
  });
  const result = run('install', {
    url: 'https://example.invalid/component.git',
    install: { run: '/usr/bin/env > custom-env.txt', runtime: 'custom' },
  }, ['--pin-refs']);
  expect(result.status).toBe(0);
  const installs = gitEnvironments();
  expect(installs.filter(({ args }) => args[0] === 'clone')).toHaveLength(2);
  expect(installs.filter(({ args }) => args[0] === 'ls-remote')).toHaveLength(2);
  for (const call of installs) {
    // Resolution never injects requirements into any subprocess.
    expect(call.env).toEqual(allowed);
  }
  for (const path of ['app/install-env.txt', 'component/custom-env.txt']) {
    expect(buildEnvFile(join(dir, 'out', path))).toEqual(allowed);
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
  for (const key of Object.keys(auth).filter(key => key !== 'SSH_AUTH_SOCK')) expect(builds[key]).toBeUndefined();
  expect(builds.SSH_AUTH_SOCK).toBe(auth.SSH_AUTH_SOCK);
  const calls = gitEnvironments();
  expect(calls.some(({ args }) => args[0] === 'fetch')).toBe(true);
  expect(calls.some(({ args }) => args[0] === 'checkout')).toBe(true);
  expect(calls.filter(({ args }) => args[0] === 'ls-remote')).toHaveLength(2);
  for (const call of calls) {
    expect(call.env).toEqual({ ...builds, ...auth });
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

for (const command of ['build', 'install', 'check']) {
  for (const prefix of [' ', '\t']) {
    for (const pin of [false, true]) {
      test(`${command}: whitespace-token URLs are rejected before use (prefix=${JSON.stringify(prefix)}, pin=${pin})`, () => {
        const result = run(command, { url: `${prefix}https://ghp_${SECRET}@example.invalid/repo.git` }, pin ? ['--pin-refs'] : []);
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).not.toContain(SECRET);
        expect(result.stdout + result.stderr).toContain('mcpServers.fixture.source.url');
        expect(gitCalls()).toBe('');
        expect(existsSync(join(dir, 'out'))).toBe(false);
      });
    }
  }
}

test('source URL whitespace, ASCII controls and normalized token usernames are rejected safely', () => {
  for (const url of [
    'https://example.invalid/repo.git ', '\thttps://example.invalid/repo.git',
    ...Array.from({ length: 33 }, (_, i) => `https://example.invalid/repo${String.fromCharCode(i === 32 ? 127 : i)}.git`),
    `https:\\\\ghp_${SECRET}@example.invalid/repo.git`,
  ]) {
    expect(() => assertCredentialFreeSourceUrl(url, 'fixture source')).toThrow('fixture source');
    try { assertCredentialFreeSourceUrl(url); } catch (err) {
      expect(String(err)).not.toContain(SECRET);
      expect(String(err)).not.toContain('https:');
    }
  }
});

for (const command of ['build', 'install']) {
  test(`${command}: pin resolution honors sslBypass`, () => {
    env.FAKE_REQUIRE_SSL = 'https://example.invalid/component.git';
    const result = run(command, { url: env.FAKE_REQUIRE_SSL, sslBypass: true }, ['--pin-refs']);
    expect(result.status).toBe(0);
    expect(gitCalls()).toContain('["-c","http.sslVerify=false","ls-remote"');
    expect(readFileSync(join(dir, 'out/connectome.lock'), 'utf-8')).toContain(SHA);
  });
}

for (const extension of [false, true]) {
  test(`pin failures name the ${extension ? 'extension' : 'MCP'} source and omit git helper output`, () => {
    env.FAKE_MISSING_URL = 'https://example.invalid/component.git';
    const result = run('build', { url: env.FAKE_MISSING_URL }, ['--pin-refs'], extension);
    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).toContain(`${join(dir, 'recipe.json')} :: ${extension ? 'extensions' : 'mcpServers'}.fixture.source`);
    expect(output).toContain('remote unreachable or refused (git ls-remote exit 1)');
    expect(output).not.toContain('TLS handshake failed');
    expect(output).not.toContain('check the custom CA');
    expect(output).not.toContain('remote unavailable');
    expect(output).not.toContain('old diagnostic');
    expect(output).not.toContain('ref not found');
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });
  test(`private symbolic pin errors name the ${extension ? 'extension' : 'MCP'} source`, () => {
    delete env.GIT_TOKEN;
    const result = run('build', { url: 'https://example.invalid/private.git', authSecret: 'GIT_TOKEN' }, ['--pin-refs'], extension);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(`${join(dir, 'recipe.json')} :: ${extension ? 'extensions' : 'mcpServers'}.fixture.source`);
    expect(result.stdout + result.stderr).toContain('authSecret');
    expect(gitCalls()).toBe('');
  });
}

test('a missing ref is distinguished from a failed remote and names the source', () => {
  env.FAKE_EMPTY_URL = 'https://example.invalid/component.git';
  const result = run('build', { url: env.FAKE_EMPTY_URL, ref: 'missing' }, ['--pin-refs']);
  const output = result.stdout + result.stderr;
  expect(result.status).not.toBe(0);
  expect(output).toContain('ref not found');
  expect(output).toContain('mcpServers.fixture.source');
  expect(output).not.toContain('remote unreachable or refused');
  expect(existsSync(join(dir, 'out'))).toBe(false);
});

for (const ref of ['dead', 'deadb', 'deadbe', 'deadbee', '20241105', 'a'.repeat(39)]) {
  test(`hex-looking symbolic ref ${ref} is resolved, not trusted`, () => {
    const result = run('build', { url: 'https://example.invalid/component.git', ref }, ['--pin-refs']);
    expect(result.status).toBe(0);
    expect(gitCalls()).toContain(`refs/heads/${ref}`);
    expect(readFileSync(join(dir, 'out/connectome.lock'), 'utf-8')).toContain(SHA);
  });
  test(`unresolvable hex-looking ref ${ref} fails closed`, () => {
    env.FAKE_EMPTY_URL = 'https://example.invalid/component.git';
    const result = run('build', { url: env.FAKE_EMPTY_URL, ref }, ['--pin-refs']);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(`'${ref}' looks like an abbreviated commit ID`);
    expect(result.stdout + result.stderr).toContain(`--pin-refs needs the full 40-hex ID (git rev-parse ${ref})`);
    expect(gitCalls()).toContain(`refs/heads/${ref}`);
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });
}

for (const ref of ['b'.repeat(40), 'B'.repeat(40), 'c'.repeat(64)]) {
  test(`full object ID (${ref.length} chars) can be trusted without remote resolution`, () => {
    const url = 'https://example.invalid/component.git';
    const result = run('build', { url, ref, authSecret: 'GIT_TOKEN' }, ['--pin-refs']);
    expect(result.status).toBe(0);
    expect(gitCalls()).not.toContain(url);
    expect(readFileSync(join(dir, 'out/connectome.lock'), 'utf-8')).toContain(ref.toLowerCase());
  });
}

for (const url of [
  'https://%20ghp_CANARY123@example.invalid/x.git',
  'https:// ghp_CANARY123@example.invalid/x.git',
  ...['\u00a0', '\u2028', '\ufeff'].map(space => `https://${space}ghp_CANARY123@example.invalid/x.git`),
  'https://%C2%A0ghp_CANARY123@example.invalid/x.git',
  '//ghp_CANARY123@example.invalid/x.git',
  'https:/\\ghp_CANARY123@example.invalid/x.git',
  'https:\\ghp_CANARY123@example.invalid/x.git',
  '//example.invalid/x.git',
]) {
  test(`R2-1: URL-shaped or whitespace userinfo input is rejected: ${JSON.stringify(url)}`, () => {
    expect(() => assertCredentialFreeSourceUrl(url, 'fixture source')).toThrow('fixture source');
    try { assertCredentialFreeSourceUrl(url); } catch (err) {
      expect(String(err)).not.toContain('CANARY123');
    }
  });
}

test('R2-1: cook build rejects encoded-space token canary without writing any output', () => {
  const result = run('build', { url: 'https://%20ghp_CANARY123@example.invalid/x.git' });
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).not.toContain('CANARY123');
  expect(gitCalls()).toBe('');
  expect(existsSync(join(dir, 'out'))).toBe(false);
});

test('R2-3: --ch-ref abbreviated commit failure explains the full-ID requirement', () => {
  env.FAKE_EMPTY_URL = 'https://example.invalid/host.git';
  const result = run('install', undefined, ['--pin-refs', '--ch-repo', env.FAKE_EMPTY_URL, '--ch-ref', 'deadbee']);
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("'deadbee' looks like an abbreviated commit ID");
  expect(result.stdout + result.stderr).toContain('--pin-refs needs the full 40-hex ID (git rev-parse deadbee)');
  expect(existsSync(join(dir, 'out'))).toBe(false);
});

for (const [command, customRepo] of [['build', false], ['install', false], ['install', true]] as const) {
  for (const failure of ['remote', 'ref']) {
    test(`R2-5: ${command} ${customRepo ? 'custom' : 'default'} host ${failure} error uses the repository label`, () => {
      const url = customRepo ? 'https://example.invalid/host.git'
        : 'https://github.com/anima-research/connectome-host.git';
      if (failure === 'remote') env.FAKE_MISSING_URL = url;
      else env.FAKE_EMPTY_URL = url;
      const result = run(command, undefined, ['--pin-refs', ...(customRepo ? ['--ch-repo', url] : [])]);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(`connectome-host (${url}):`);
      expect(result.stdout + result.stderr).not.toContain('--ch-repo (connectome-host)');
      expect(result.stdout + result.stderr).not.toContain('ref not found: connectome-host@');
      expect(existsSync(join(dir, 'out'))).toBe(false);
    });
  }
}

// Regressions for invisible characters, in literal and encoded userinfo.
for (const char of ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u180e', '\u00ad', '\u034f', '\u0085', '\u2029', '\u3000']) {
  for (const spelling of [char, encodeURIComponent(char)]) {
    for (const part of ['username', 'password']) {
      test(`R2-1: invisible userinfo ${char.codePointAt(0)!.toString(16)} ${spelling === char ? 'literal' : 'encoded'} ${part}`, () => {
        const userinfo = part === 'username' ? `${spelling}ghp_CANARY123` : `git:${spelling}ghp_CANARY123`;
        expect(() => assertCredentialFreeSourceUrl(`https://${userinfo}@example.invalid/x.git`)).toThrow('embedded credentials');
      });
    }
  }
}

for (const url of ['git@host:org/repo.git', 'ssh://git@host:22/x', 'ssh://git@[::1]:22/x', 'https://user@[::1]/x', 'user@host:org/repo.git', 'user@', 'file:///tmp/repo', '/tmp/repo', './local repo', 'https://user-name.1@host/x', 'https://host/x']) {
  test(`R2-1: legitimate source remains accepted: ${url}`, () => {
    expect(() => assertCredentialFreeSourceUrl(url)).not.toThrow();
  });
}

test('R2-1: cook build rejects encoded invisible token canary without any output', () => {
  const result = run('build', { url: 'https://%E2%80%8Bghp_CANARY123@example.invalid/x.git' });
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).not.toContain('CANARY123');
  expect(gitCalls()).toBe('');
  expect(existsSync(join(dir, 'out'))).toBe(false);
});

// Production CLI probe: start with a real artifact bundle, then ensure rejected
// URLs neither overwrite any artifact nor leave the canary in any output file.
test('R3 production probe: all reviewed bypasses leave every generated file canary-free and unchanged', () => {
  const out = join(dir, 'out');
  const files = (path: string): string[] => readdirSync(path, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]);
  const control = run('build', { url: 'https://user-name.1@example.invalid/x.git' });
  expect(control.status).toBe(0);
  const before = new Map(files(out).map(path => [path, readFileSync(path, 'utf-8')]));
  for (const name of ['Dockerfile', 'README.md', 'connectome.lock']) {
    expect(before.has(join(out, name))).toBe(true);
  }
  expect([...before.keys()].some(path => path.includes('/recipes/'))).toBe(true);
  const usernames = [
    ...['\u200b', '\u200c', '\u200d', '\u180e', '\ufeff', '\u0301', '\u0300', '\u20dd', 'ｇ', ' ', '\t']
      .flatMap(char => [char, encodeURIComponent(char)]).map(char => `${char}ghp_CANARY123`),
    'user-GhP_CANARY123', 'user-%67hp_CANARY123', 'ｇｈｐ_CANARY123', '%25ghp_CANARY123',
  ];
  for (const extension of [false, true]) {
    for (const username of usernames) {
      const result = run('build', { url: `https://${username}@example.invalid/x.git` }, [], extension);
      expect(result.stdout + result.stderr).not.toContain('CANARY123');
      expect(files(out).sort()).toEqual([...before.keys()].sort());
      for (const path of files(out)) {
        const contents = readFileSync(path, 'utf-8');
        expect(contents).not.toContain('CANARY123');
        expect(contents).toBe(before.get(path)!);
      }
      expect(result.status).not.toBe(0);
    }
  }
  expect(gitCalls()).toBe('');
  console.log(`R3 production probe: ${usernames.length * 2} refused builds; ${before.size} files checked per build; no canary or writes`);
});

for (const failure of ['clone', 'fetch', 'checkout', 'ls-remote']) {
  test(`R1-1: private ${failure} errors suppress helper output`, () => {
    env.FAKE_FAIL_GIT = failure;
    const result = run('install', {
      url: 'https://example.invalid/private.git', ref: 'refs/pull/1/head', authSecret: 'GIT_TOKEN',
    }, failure === 'ls-remote' ? ['--pin-refs'] : []);
    expect(result.status).not.toBe(0);
    expect(gitCalls()).toContain(failure);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(Buffer.from(`oauth2:${SECRET}`).toString('base64'));
    expect(output).toContain(failure === 'ls-remote' ? 'mcpServers.fixture.source' : 'git');
  });
}

test('R1-4: custom CA, client certificates and desktop helper settings go exactly to Git only', () => {
  const gitOnly = {
    GIT_SSL_CAINFO: '/synthetic/ca.pem', GIT_SSL_CAPATH: '/synthetic/certs',
    GIT_SSL_CERT: '/synthetic/client.pem', GIT_SSL_KEY: '/synthetic/client.key',
    GIT_PROXY_SSL_CAINFO: '/synthetic/proxy-ca.pem', GIT_PROXY_SSL_CAPATH: '/synthetic/proxy-certs',
    GIT_PROXY_SSL_CERT: '/synthetic/proxy-client.pem', GIT_PROXY_SSL_KEY: '/synthetic/proxy-client.key',
    GIT_CONFIG_NOSYSTEM: '1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/synthetic/bus',
    XDG_RUNTIME_DIR: '/synthetic/runtime', GCM_CREDENTIAL_STORE: 'secretservice',
    GCM_INTERACTIVE: 'never', GH_TOKEN: 'synthetic-gh-token', GITHUB_TOKEN: 'synthetic-github-token',
  };
  Object.assign(env, gitOnly);
  const result = run('install', {
    url: 'https://example.invalid/component.git', ref: 'refs/pull/1/head',
    install: { run: '/usr/bin/env > custom-env.txt', runtime: 'custom' },
  }, ['--pin-refs']);
  expect(result.status).toBe(0);
  for (const call of gitEnvironments()) {
    expect(call.env).toEqual({
      PATH: env.PATH!, HOME: dir, TMPDIR: dir,
      ...gitOnly,
    });
  }
  for (const path of ['app/install-env.txt', 'component/custom-env.txt']) {
    expect(buildEnvFile(join(dir, 'out', path))).toEqual({ PATH: env.PATH!, HOME: dir, TMPDIR: dir });
  }
});

test('R1-5: host builds inherit well-known locale, package-manager and toolchain inputs', () => {
  const defaults = {
    LC_CTYPE: 'C', LC_MESSAGES: 'C', USER: 'operator', LOGNAME: 'operator', SHELL: '/bin/sh',
    PYTHON: '/synthetic/python', npm_config_registry: 'https://mirror.invalid/npm',
    PIP_INDEX_URL: 'https://mirror.invalid/pip', UV_INDEX_URL: 'https://mirror.invalid/uv',
    CARGO_HOME: '/synthetic/cargo', RUSTUP_HOME: '/synthetic/rustup', PKG_CONFIG_PATH: '/synthetic/pkgconfig',
    CC: '/synthetic/cc', CXX: '/synthetic/cxx', REQUESTS_CA_BUNDLE: '/synthetic/ca.pem',
    SSH_AUTH_SOCK: '/synthetic/ssh.sock',
  };
  Object.assign(env, defaults);
  const result = run('install', {
    url: 'https://example.invalid/component.git',
    install: { run: '/usr/bin/env > custom-env.txt', runtime: 'custom' },
  });
  expect(result.status).toBe(0);
  for (const path of ['app/install-env.txt', 'component/custom-env.txt']) {
    expect(buildEnvFile(join(dir, 'out', path))).toEqual({ PATH: env.PATH!, HOME: dir, TMPDIR: dir, ...defaults });
  }
});

test('R1-5: operator pass-through is ephemeral and requires explicit selection for provider secrets', () => {
  const passed = 'synthetic-operator-build-token';
  Object.assign(env, {
    COOK_PASS_ENV: 'NPM_TOKEN, EXTRA_TOOL\tUNSET_TOOL COOK_TEST_SECRET ANTHROPIC_API_KEY GIT_SSL_KEY',
    NPM_TOKEN: passed, EXTRA_TOOL: '/synthetic/tool', GIT_SSL_KEY: '/synthetic/client.key',
  });
  const result = run('install', {
    url: 'https://example.invalid/component.git',
    install: { run: '/usr/bin/env > custom-env.txt', runtime: 'custom' },
  }, ['--pin-refs']);
  expect(result.status).toBe(0);
  for (const path of ['app/install-env.txt', 'component/custom-env.txt']) {
    const build = buildEnvFile(join(dir, 'out', path));
    expect(build.NPM_TOKEN).toBe(passed);
    expect(build.EXTRA_TOOL).toBe('/synthetic/tool');
    expect(build.UNSET_TOOL).toBeUndefined();
    expect(build.ANTHROPIC_API_KEY).toBe(SECRET);
    expect(build.GIT_SSL_KEY).toBe('/synthetic/client.key');
    expect(build.COOK_PASS_ENV).toBeUndefined();
  }
  const out = join(dir, 'out');
  const artifacts = (path: string): string[] => readdirSync(path, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? artifacts(join(path, entry.name))
      : /^(install-env|custom-env)\.txt$/.test(entry.name) ? [] : [readFileSync(join(path, entry.name), 'utf-8')]);
  expect(artifacts(out).join('\n') + result.stdout + result.stderr).not.toContain(passed);
});

test('R5: selected authSecret/credential envOverride names use parent values in builds only', () => {
  Object.assign(env, {
    PIP_PRIVATE_TOKEN: 'synthetic-source-token', npm_config_credential: 'synthetic-credential-token',
    COOK_PASS_ENV: 'PIP_PRIVATE_TOKEN npm_config_credential',
  });
  const recipe = join(dir, 'secret-recipe.json');
  writeFileSync(recipe, JSON.stringify({ name: 'Known secrets', agent: { systemPrompt: 'test' },
    mcpServers: { fixture: { command: 'node', source: {
      url: 'https://example.invalid/component.git', authSecret: 'PIP_PRIVATE_TOKEN',
      install: { run: '/usr/bin/env > custom-env.txt', runtime: 'custom' },
    }, credentialFiles: [{ path: './credential', format: 'env', fields: [{ name: 'token', prompt: 'token', envOverride: 'npm_config_credential' }] }] } },
  }));
  writeFileSync(join(dir, 'git-behavior.json'), '{}');
  const result = spawnSync(process.execPath, [CLI, 'install', recipe, '--out', join(dir, 'out'), '--yes', '--no-prompts', '--pin-refs'], { env, encoding: 'utf-8' });
  expect(result.status).toBe(0);
  for (const path of ['app/install-env.txt', 'component/custom-env.txt']) {
    const build = buildEnvFile(join(dir, 'out', path));
    expect(build.PIP_PRIVATE_TOKEN).toBe('synthetic-source-token');
    expect(build.npm_config_credential).toBe('synthetic-credential-token');
    expect(build.COOK_PASS_ENV).toBeUndefined();
  }
  for (const call of gitEnvironments()) {
    expect(call.env.PIP_PRIVATE_TOKEN).toBeUndefined();
    expect(call.env.npm_config_credential).toBeUndefined();
  }
});

test('R1-5: malformed pass-through selectors fail without echoing values or writing artifacts', () => {
  env.COOK_PASS_ENV = `NPM_TOKEN=${SECRET}`;
  const result = run('install', { url: 'https://example.invalid/component.git' });
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('COOK_PASS_ENV');
  expect(result.stdout + result.stderr).not.toContain(SECRET);
  expect(existsSync(join(dir, 'out'))).toBe(false);
});

for (const name of [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'SIDECAR_SECRET',
  'PIP_SIDECAR_TOKEN', 'GIT_SSL_KEY', 'DBUS_SESSION_BUS_ADDRESS', 'ARBITRARY_REQUIREMENT', 'SOURCE_SECRET',
]) {
  for (const requirement of [false, true]) {
    for (const selection of ['none', 'parent', 'unset'] as const) {
      test(`R5: parent-only build inputs ${name} (requirement=${requirement}, selection=${selection})`, () => {
        const parentValue = `synthetic-parent-${name}`;
        const resolvedValue = `synthetic-env-file-${name}`;
        env[name] = parentValue;
        // An unset selected parent name must not fall back to resolved
        // requirement/--env-file values.
        if (selection === 'none') delete env.COOK_PASS_ENV;
        else env.COOK_PASS_ENV = name;
        if (selection === 'unset') delete env[name];
        const envFile = join(dir, 'collision.env');
        writeFileSync(envFile, `${name}=${resolvedValue}\n`);
        const recipe = join(dir, 'collision.json');
        writeFileSync(join(dir, 'git-behavior.json'), '{}');
        writeFileSync(recipe, JSON.stringify({
          name: 'Secret collision', agent: { systemPrompt: 'test' },
          ...(requirement ? { requirements: { collision: { exposeAs: name } } } : {}),
          ...(['SIDECAR_SECRET', 'PIP_SIDECAR_TOKEN'].includes(name) ? {
            services: [{ name: 'sidecar', image: 'fixture:offline', secrets: [name] }],
          } : {}),
          mcpServers: { fixture: { command: 'node', env: { TOKEN: `\${${name}}` }, source: {
            url: 'https://example.invalid/component.git',
            ...(name === 'SOURCE_SECRET' ? { authSecret: name } : {}),
            install: { runtime: 'custom', run: '/usr/bin/env > custom-env.txt' },
          } } },
        }));
        const out = join(dir, 'out');
        const result = spawnSync(process.execPath, [CLI, 'install', recipe,
          '--out', out, '--yes', '--no-prompts', '--env-file', envFile, '--pin-refs'], { env, encoding: 'utf-8' });
        expect(result.status).toBe(0);
        for (const path of ['app/install-env.txt', 'component/custom-env.txt']) {
          const build = buildEnvFile(join(out, path));
          expect(build[name]).toBe(selection === 'parent' ? parentValue : undefined);
          expect(build.COOK_PASS_ENV).toBeUndefined();
        }
        // Opt-in affects subprocesses only, not main's runtime/lock semantics.
        expect(readFileSync(join(out, '.env'), 'utf-8')).toContain(`${name}='${resolvedValue}'`);
        expect(statSync(join(out, '.env')).mode & 0o777).toBe(0o600);
        const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf-8'));
        if (requirement) expect(lock.requirements[0].value).toBe(resolvedValue);
        const emitted = JSON.parse(readFileSync(join(out, 'recipes/collision.json'), 'utf-8'));
        expect(emitted.mcpServers.fixture.env.TOKEN).toBe(`\${${name}}`);
        for (const call of gitEnvironments()) {
          // Acquisition has its own policy; no resolved requirement/env-file
          // value is copied as a raw environment entry (auth uses a header).
          expect(call.env[name]).not.toBe(resolvedValue);
          if (['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'SIDECAR_SECRET', 'PIP_SIDECAR_TOKEN', 'SOURCE_SECRET'].includes(name)) {
            expect(call.env[name]).toBeUndefined();
          }
        }
        expect(result.stdout + result.stderr).not.toContain(parentValue);
        expect(result.stdout + result.stderr).not.toContain(resolvedValue);
      });
    }
  }
}

for (const selection of ['none', 'parent', 'unset'] as const) {
  test(`R5: probed requirement is runtime-only (selection=${selection})`, () => {
    if (selection !== 'none') env.COOK_PASS_ENV = 'SDK_ROOT';
    if (selection !== 'unset') env.SDK_ROOT = '/synthetic/parent-sdk';
    const result = run('install', {
      url: 'https://example.invalid/component.git',
      install: { run: '/usr/bin/env > custom-env.txt', runtime: 'custom' },
    });
    expect(result.status).toBe(0);
    for (const path of ['app/install-env.txt', 'component/custom-env.txt']) {
      expect(buildEnvFile(join(dir, 'out', path)).SDK_ROOT).toBe(selection === 'parent' ? env.SDK_ROOT : undefined);
    }
    const lock = JSON.parse(readFileSync(join(dir, 'out/connectome.lock'), 'utf-8'));
    expect(lock.requirements[0]).toMatchObject(selection === 'unset'
      ? { value: dir, origin: 'probe' } : { value: env.SDK_ROOT, origin: 'process-env' });
  });
}

test('R5: env-file requirements cannot overwrite even base allowlist settings', () => {
  const recipe = join(dir, 'base.json');
  const envFile = join(dir, 'base.env');
  writeFileSync(join(dir, 'git-behavior.json'), '{}');
  writeFileSync(recipe, JSON.stringify({ name: 'Base collision', agent: { systemPrompt: 'test' },
    requirements: { home: { exposeAs: 'HOME' }, compiler: { exposeAs: 'CC' } },
    mcpServers: { fixture: { command: 'node', source: { url: 'https://example.invalid/component.git',
      install: { runtime: 'custom', run: '/usr/bin/env > custom-env.txt' },
    } } },
  }));
  writeFileSync(envFile, 'HOME=/synthetic/resolved-home\nCC=/synthetic/resolved-cc\n');
  env.CC = '/synthetic/parent-cc';
  const result = spawnSync(process.execPath, [CLI, 'install', recipe, '--out', join(dir, 'out'),
    '--yes', '--no-prompts', '--env-file', envFile], { env, encoding: 'utf-8' });
  expect(result.status).toBe(0);
  for (const path of ['app/install-env.txt', 'component/custom-env.txt']) {
    const build = buildEnvFile(join(dir, 'out', path));
    expect(build.HOME).toBe(dir);
    expect(build.CC).toBe(env.CC);
  }
});

test('R5: selecting Git controls affects builds, not acquisition repository routing', () => {
  const selected = {
    GIT_DIR: '/synthetic/not-a-repository', GIT_WORK_TREE: '/synthetic/not-a-worktree',
    GIT_CONFIG_PARAMETERS: 'synthetic-not-git-config',
  };
  Object.assign(env, selected, { COOK_PASS_ENV: Object.keys(selected).join(',') });
  const result = run('install', {
    url: 'https://example.invalid/component.git',
    install: { run: '/usr/bin/env > custom-env.txt', runtime: 'custom' },
  }, ['--pin-refs']);
  expect(result.status).toBe(0);
  for (const path of ['app/install-env.txt', 'component/custom-env.txt']) {
    expect(buildEnvFile(join(dir, 'out', path))).toMatchObject(selected);
  }
  for (const call of gitEnvironments()) {
    for (const key of Object.keys(selected)) expect(call.env[key]).toBeUndefined();
  }
});
