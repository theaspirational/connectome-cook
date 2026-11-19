import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { layoutTestDirectory } from './test-layout-directory.js';
import { localSourceUploadPack } from './source-url.js';
import { BUN_INSTALL_ARGS, bindHostEngine, planHostActions } from './backends/host.js';
import { REAL_GIT, expectedUploadPack, readArgv, writeForeignGit } from './test-support/foreign-git.js';

const uploadPack = expectedUploadPack;

test('upload-pack exception: exact path only, local absolute paths only', () => {
  expect(localSourceUploadPack('/srv/sources/host')).toBe("git -c 'safe.directory=/srv/sources/host' -c 'safe.directory=/srv/sources/host/.git' upload-pack");
  expect(localSourceUploadPack('/srv/sources/host')).not.toContain('*');
  for (const url of ['https://example.org/x.git', 'http://127.0.0.1/x', 'ssh://git@example.org/x', 'git@example.org:x.git',
    'file:///srv/x', 'relative/path', './x', '//example.org/x']) expect(localSourceUploadPack(url)).toBeUndefined();
});
test('upload-pack exception refuses shell- or safe.directory-significant local paths', () => {
  for (const bad of [' ', '\t', '\n', '\r', '\x00', '\x1b', '\x7f', ' ', ' ', "'", '"', '`', '\\', '%', '*'])
    expect(() => localSourceUploadPack(`/srv/a${bad}b`, 'here')).toThrow(/^E_LOCAL_SOURCE_PATH: here: /);
  // Refused paths are never echoed (they reach diagnostics otherwise).
  try { localSourceUploadPack('/srv/secret dir'); } catch (error) { expect((error as Error).message).not.toContain('secret'); }
  // Only local absolute URLs are checked; remote URLs keep their existing validation.
  expect(localSourceUploadPack('https://example.org/a%20b.git')).toBeUndefined();
});
test('every bun install cook runs disables lifecycle scripts', () => {
  expect(BUN_INSTALL_ARGS).toEqual(['install', '--ignore-scripts']);
  const plan = { sources: [], localExtensions: [], walks: [] } as unknown as Parameters<typeof planHostActions>[0];
  const actions = planHostActions(plan, { installDir: '/x', chRepoUrl: '/srv/host', chRef: 'main' } as Parameters<typeof planHostActions>[1]);
  expect(actions.clones[0]!.buildCommand).toBe('bun install --ignore-scripts');
  bindHostEngine(actions, '/opt/bun 1/bun');
  expect(actions.clones[0]!.buildCommand).toBe("'/opt/bun 1/bun' install --ignore-scripts");
});

// End to end with real Git; root-owned sources simulated by writeForeignGit.
let dir: string, bin: string, host: string, component: string, recipe: string, out: string, argvLog: string, bunLog: string;
beforeEach(() => {
  dir = layoutTestDirectory('cook-local-source-');
  bin = join(dir, 'bin'); mkdirSync(bin);
  argvLog = join(dir, 'git-argv.log'); bunLog = join(dir, 'bun-argv.log');
  const repo = (path: string, files: Record<string, string>) => {
    mkdirSync(path);
    const git = (args: string[]) => execFileSync(REAL_GIT, args, { cwd: path, stdio: 'pipe' });
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.org']);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(path, name), body);
    git(['add', '.']); git(['commit', '-qm', 'fixture']);
    git(['checkout', '-qb', 'topic']); writeFileSync(join(path, 'topic'), 'topic'); git(['add', '.']); git(['commit', '-qm', 'topic']);
    git(['checkout', '-q', 'main']);
  };
  host = join(dir, 'host-src');
  repo(host, { 'package.json': JSON.stringify({ name: 'host-fixture', engines: { bun: '>=1.4.3', node: '>=22.12.0' } }) });
  component = join(dir, 'component-src');
  repo(component, { 'index.js': '// fixture' });
  writeForeignGit(bin, join(bin, 'foreign'), argvLog);
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.4; exit 0; fi\nprintf '%s\\n' "$*" >> '${bunLog}'\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'node'), '#!/bin/sh\necho v22.23.3\n', { mode: 0o755 });
  recipe = join(dir, 'recipe.json'); out = join(dir, 'install');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeRecipe(url: string, ref = 'main') {
  writeFileSync(recipe, JSON.stringify({ name: 'Fixture', agent: { systemPrompt: 'Test' }, mcpServers: { comp: {
    command: 'node', args: ['index.js'], source: { url, ref, install: { runtime: 'custom', run: 'true' } },
  } } }));
}
function install(chRef: string, extra: string[] = [], gitConfig = '') {
  const globalConfig = join(dir, 'gitconfig');
  writeFileSync(globalConfig, gitConfig);
  return spawnSync(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', host, '--ch-ref', chRef,
    '--no-prompts', '--yes', ...extra], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, TMPDIR: dir, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' },
  });
}
const argv = () => readArgv(argvLog);
const checkoutGit = (cwd: string, args: string[]) => execFileSync(join(bin, 'git'), args, { cwd, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'gitconfig') } }).trim();

for (const mode of ['plain', 'insteadOf file://'] as const) for (const pin of [false, true]) test(`foreign-owned local sources clone and fetch (${mode}${pin ? ', --pin-refs' : ''})`, () => {
  writeFileSync(join(bin, 'foreign'), `${host}\n${component}\n`);
  writeRecipe(component, 'refs/heads/topic');
  // Kitchen's rewrite: local paths reach Git as file:// URLs.
  const rewrite = mode === 'plain' ? '' : [host, component].map(p => `[url "file://${p}"]\n\tinsteadOf = ${p}\n`).join('');
  const result = install('refs/heads/topic', pin ? ['--pin-refs'] : [], rewrite);
  if (result.status) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
  for (const [src, target] of [[host, join(out, 'app')], [component, join(out, 'component-src')]] as const) {
    const clone = argv().find(args => args.includes('clone') && args.includes(src))!;
    expect(clone.slice(clone.indexOf('clone'))).toEqual(['clone', '--no-local', '-u', uploadPack(src), src, target]);
    // Later fetches reuse the same exact-path exception.
    expect(checkoutGit(target, ['config', '--get-all', 'remote.origin.uploadpack'])).toBe(uploadPack(src));
    expect(existsSync(join(target, 'topic'))).toBe(true);
    // The install itself fetched the refs/ ref from the foreign source…
    expect(argv().some(args => args[0] === 'fetch' && args[1] === 'origin' && args[2]!.startsWith('refs/heads/topic'))).toBe(true);
    // …and a later fetch from the checkout still works.
    checkoutGit(target, ['fetch', '-q', 'origin', 'main']);
  }
  expect(argv().some(args => args.includes('safe.directory=*') || args.some(a => a.includes("safe.directory=*'")))).toBe(false);
  if (pin) expect(argv().filter(args => args.includes('ls-remote')).every(args => args.includes(`--upload-pack=${uploadPack(args.at(-2)!)}`))).toBe(true);
  expect(readFileSync(bunLog, 'utf8')).toBe('install --ignore-scripts\n');
});

test('foreign-owned local host via engine preflight (fetch into scratch, then local materialization)', () => {
  writeFileSync(join(bin, 'foreign'), `${host}\n${component}\n`);
  writeRecipe(component);
  const result = install('main', ['--bun-path', join(bin, 'bun'), '--node-path', join(bin, 'node')]);
  if (result.status) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
  const fetch = argv().find(args => args.includes('fetch') && args.includes(host))!;
  expect(fetch).toContain(`--upload-pack=${uploadPack(host)}`);
  expect(checkoutGit(join(out, 'app'), ['config', '--get', 'remote.origin.url'])).toBe(host);
  expect(checkoutGit(join(out, 'app'), ['config', '--get', 'remote.origin.uploadpack'])).toBe(uploadPack(host));
  checkoutGit(join(out, 'app'), ['fetch', '-q', 'origin', 'main']);
  expect(readFileSync(bunLog, 'utf8')).toBe('install --ignore-scripts\n');
});

test('https sources keep the unchanged clone argv and no upload-pack override', () => {
  // Real Git reaches the local fixture through insteadOf; cook only sees https.
  const url = 'https://example.invalid/component.git';
  writeRecipe(url);
  const result = install('main', [], `[url "${component}"]\n\tinsteadOf = ${url}\n`);
  if (result.status) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
  const clone = argv().find(args => args.includes(url))!;
  expect(clone).toEqual(['clone', url, join(out, 'component')]);
  // The local host still gets its exception; nothing else does.
  expect(argv().some(args => args.some(a => a.includes('upload-pack') && !a.includes(`safe.directory=${host}'`)))).toBe(false);
  expect(spawnSync(REAL_GIT, ['config', '--get', 'remote.origin.uploadpack'], { cwd: join(out, 'component') }).status).toBe(1);
});

test('refuses an unsafe local source path before any install change', () => {
  const bad = join(dir, "bad 'src");
  writeRecipe(bad);
  const result = install('main');
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('E_LOCAL_SOURCE_PATH');
  expect(existsSync(out)).toBe(false);
  expect(existsSync(argvLog) && argv().some(args => args.includes('clone'))).toBe(false);
});

test('upload-pack exception strips trailing slashes from the local path (no realpath)', () => {
  expect(localSourceUploadPack('/srv/sources/host/')).toBe(uploadPack('/srv/sources/host'));
  expect(localSourceUploadPack('/srv/sources/host///')).toBe(uploadPack('/srv/sources/host'));
  expect(localSourceUploadPack('/srv/link/../host/')).toBe(uploadPack('/srv/link/../host'));
});
test('trailing-slash local source paths: clone, refs fetch, --pin-refs and later fetches', () => {
  const hostSlash = `${host}/`, componentSlash = `${component}/`;
  writeFileSync(join(bin, 'foreign'), `${host}\n${component}\n${hostSlash}\n${componentSlash}\n`);
  writeRecipe(componentSlash, 'refs/heads/topic');
  const globalConfig = join(dir, 'gitconfig');
  writeFileSync(globalConfig, '');
  const result = spawnSync(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', hostSlash, '--ch-ref', 'refs/heads/topic',
    '--no-prompts', '--yes', '--pin-refs'], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, TMPDIR: dir, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (result.status) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
  for (const [src, target] of [[host, join(out, 'app')], [component, join(out, 'component-src')]] as const) {
    expect(checkoutGit(target, ['config', '--get-all', 'remote.origin.uploadpack'])).toBe(uploadPack(src));
    expect(existsSync(join(target, 'topic'))).toBe(true);
    checkoutGit(target, ['fetch', '-q', 'origin', 'main']);
  }
  expect(argv().some(args => args[0] === 'fetch' && args[1] === 'origin' && args[2]!.startsWith('refs/heads/topic'))).toBe(true);
  const lsRemote = argv().filter(args => args.includes('ls-remote'));
  expect(lsRemote.length).toBeGreaterThan(0);
  expect(argv().some(args => args.some(a => a.includes('safe.directory=') && /\/'|\/\/\.git/.test(a)))).toBe(false);
});

test('trailing-slash local host via engine preflight', () => {
  writeFileSync(join(bin, 'foreign'), `${host}\n${component}\n${host}/\n`);
  writeRecipe(component);
  host = `${host}/`;
  const result = install('main', ['--bun-path', join(bin, 'bun'), '--node-path', join(bin, 'node'), '--pin-refs']);
  host = host.slice(0, -1);
  if (result.status) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
  expect(argv().find(args => args.includes('fetch') && args.includes(host))).toContain(`--upload-pack=${uploadPack(host)}`);
  expect(checkoutGit(join(out, 'app'), ['config', '--get', 'remote.origin.url'])).toBe(host);
  expect(checkoutGit(join(out, 'app'), ['config', '--get', 'remote.origin.uploadpack'])).toBe(uploadPack(host));
  checkoutGit(join(out, 'app'), ['fetch', '-q', 'origin', 'main']);
});

test('local path source: a commit reachable only via a non-branch, non-tag ref fails closed with guidance', () => {
  const git = (args: string[]) => execFileSync(REAL_GIT, args, { cwd: host, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['checkout', '-qb', 'keep']); writeFileSync(join(host, 'kept'), 'kept'); git(['add', '.']); git(['commit', '-qm', 'kept']);
  const sha = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/keep/x', sha]); git(['checkout', '-q', 'main']); git(['branch', '-qD', 'keep']);
  writeRecipe(component);
  for (const extra of [[], ['--pin-refs']]) {
    rmSync(out, { recursive: true, force: true });
    const result = install(sha, extra);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('git checkout failed');
    expect(result.stdout + result.stderr).toContain('copies only its branches and tags');
    expect(result.stdout + result.stderr).toContain('refs/...');
  }
  // Fetching the ref by name works.
  rmSync(out, { recursive: true, force: true });
  const result = install('refs/keep/x', ['--pin-refs']);
  if (result.status) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
  expect(existsSync(join(out, 'app', 'kept'))).toBe(true);
});
