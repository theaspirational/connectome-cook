import { expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('R1-1: real Git sends the private header on loopback pin/clone/fetch, keeps credentials out of Git artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cook-git-http-'));
  const token = 'synthetic-loopback-token';
  const header = `Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
  const requests: Array<{ path: string; auth: string | null }> = [];
  const home = join(dir, 'home');
  mkdirSync(home);
  const env = {
    PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (args: string[]) => execFileSync('git', args, { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const repo = join(dir, 'repo');
  git(['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'index.js'), '');
  git(['-C', repo, 'add', 'index.js']);
  git(['-C', repo, 'commit', '-qm', 'fixture']);
  git(['-C', repo, 'update-ref', 'refs/pull/1/head', 'HEAD']);
  const bare = join(dir, 'bare.git');
  git(['clone', '--bare', repo, bare]);
  git(['--git-dir', bare, 'update-ref', 'refs/pull/1/head', 'HEAD']);
  git(['--git-dir', bare, 'update-server-info']);
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const auth = request.headers.get('authorization');
      requests.push({ path, auth });
      if (path.startsWith('/private.git/') && auth !== header) return new Response('', { status: 401 });
      const relative = path.replace(/^\/(?:private|public)\.git\//, '');
      if (relative === path || relative.includes('..')) return new Response('', { status: 404 });
      const file = join(bare, relative);
      return existsSync(file) ? new Response(Bun.file(file)) : new Response('', { status: 404 });
    },
  });
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\n/usr/bin/env > install-env.txt\n', { mode: 0o755 });
    const origin = `http://127.0.0.1:${server.port}`;
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify({
      name: 'Loopback fixture', agent: { systemPrompt: 'test' },
      mcpServers: { fixture: { command: 'node', source: {
        url: `${origin}/private.git`, ref: 'refs/pull/1/head', authSecret: 'PRIVATE_TOKEN',
        install: { run: '/usr/bin/env > build-env.txt', runtime: 'custom' },
      } } },
    }));
    const out = join(dir, 'out');
    const child = spawn(process.execPath, [resolve(import.meta.dir, '../bin/cook'), 'install', recipe,
      '--out', out, '--yes', '--no-prompts', '--pin-refs', '--ch-repo', `${origin}/public.git`], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, PRIVATE_TOKEN: token, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject); child.on('exit', resolve);
    });
    expect(output).not.toContain(token);
    expect(output).not.toContain(header);
    expect(status).toBe(0);
    expect(requests.filter(r => r.path.startsWith('/private.git/info/refs')).length).toBeGreaterThanOrEqual(3);
    expect(requests.filter(r => r.path.startsWith('/private.git/')).every(r => r.auth === header)).toBe(true);
    expect(requests.filter(r => r.path.startsWith('/public.git/')).every(r => r.auth === null)).toBe(true);
    const files = (path: string): string[] => readdirSync(path, { withFileTypes: true })
      .flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]);
    for (const path of files(out)) {
      const contents = readFileSync(path, 'utf-8');
      if (path !== join(out, '.env')) expect(contents).not.toContain(token);
      expect(contents).not.toContain(header);
    }
    expect(readFileSync(join(out, '.env'), 'utf-8')).toContain(`PRIVATE_TOKEN='${token}'`);
    expect(readFileSync(join(out, 'private/.git/config'), 'utf-8')).toContain(`${origin}/private.git`);
    console.log(`loopback Git: ${requests.length} requests; private pin/clone/fetch authenticated; public requests clean`);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
