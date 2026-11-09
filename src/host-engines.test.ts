import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import * as selected from './host-engines.js';

let dir: string, repo: string, bun: string, node: string, out: string, recipe: string;
const cleanups: Array<() => void> = [];
function script(path: string, body: string) { writeFileSync(path, '#!/bin/sh\n' + body + '\n'); chmodSync(path, 0o755); }
function git(...args: string[]) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim(); }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cook-r1-')); repo = join(dir, 'repo'); mkdirSync(repo);
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ engines: { bun: '>=1.4.3', node: '>=22.12.0' } }));
  git('add', '.'); git('commit', '-m', 'fixture');
  bun = join(dir, 'bun'); node = join(dir, 'node'); out = join(dir, 'install'); recipe = join(dir, 'recipe.json');
  script(bun, 'if [ "$1" = --version ]; then echo 1.4.4; else echo built >> "$PWD/builds"; fi');
  script(node, 'echo v22.23.3');
  writeFileSync(recipe, JSON.stringify({ name: 'Fixture', agent: { systemPrompt: 'Test' } }));
});
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); rmSync(dir, { recursive: true, force: true }); });
function preflight(ref = 'main') {
  const checked = selected.preflightHostEngines(repo, ref, bun, node);
  cleanups.push(checked.cleanup);
  return checked;
}
function install(flags = true, env = process.env) {
  return spawnSync(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--ch-ref', 'main', '--no-prompts', '--yes', ...(flags ? ['--bun-path', bun, '--node-path', node] : [])], { encoding: 'utf8', env });
}

test('R1 diagnostics: distinct safe path, execution, version and range errors', () => {
  expect(() => selected.checkEngine('relative', '*')).toThrow('E_HOST_ENGINE_PATH');
  expect(() => selected.checkEngine(join(dir, 'missing'), '*')).toThrow('not a readable executable file');
  expect(() => selected.checkEngine(dir, '*')).toThrow('E_HOST_ENGINE_PATH');
  chmodSync(bun, 0o600); expect(() => selected.checkEngine(bun, '*')).toThrow('E_HOST_ENGINE_PATH'); chmodSync(bun, 0o755);
  script(bun, 'echo SECRET_EXEC_OUTPUT >&2; exit 1');
  expect(() => selected.checkEngine(bun, '*')).toThrow('E_HOST_ENGINE_EXEC');
  expect(install().stderr).not.toContain('SECRET_EXEC_OUTPUT');
  script(bun, 'echo SECRET_VERSION_OUTPUT');
  expect(() => selected.checkEngine(bun, '*')).toThrow('E_HOST_ENGINE_VERSION: engine returned an invalid version');
  expect(install().stderr).not.toContain('SECRET_VERSION_OUTPUT');
  script(bun, 'echo 1.3.10');
  expect(() => selected.checkEngine(bun, '>=1.4.3')).toThrow('observed 1.3.10; required >=1.4.3');
  expect(() => selected.checkEngine(bun, 'SECRET_INVALID_RANGE')).toThrow('E_HOST_ENGINE_REQUIREMENT');
  const failed = install();
  expect(failed.stderr).toContain('bun observed 1.3.10; required >=1.4.3');
  expect(existsSync(out)).toBe(false);
  script(bun, 'echo 1.4.4'); script(node, 'echo v20.0.0');
  expect(install().stderr).toContain('E_HOST_ENGINE_RANGE: node observed 20.0.0; required >=22.12.0');
});

test('R1 git diagnostics: fetch, package and parse steps are safe and distinct', () => {
  expect(() => preflight('missing')).toThrow('E_HOST_ENGINE_REF:');
  const original = repo; repo = join(dir, 'SECRET_REPO');
  expect(() => preflight()).toThrow('E_HOST_ENGINE_FETCH: git fetch failed');
  expect(install().stderr).not.toContain('SECRET_REPO'); repo = original;
  rmSync(join(repo, 'package.json')); git('commit', '-am', 'missing');
  expect(() => preflight()).toThrow('E_HOST_ENGINE_PACKAGE: git show package.json failed');
  writeFileSync(join(repo, 'package.json'), 'SECRET_JSON'); git('add', '.'); git('commit', '-m', 'invalid');
  expect(() => preflight()).toThrow('E_HOST_ENGINE_PACKAGE: invalid package.json');
  writeFileSync(join(repo, 'package.json'), '{}'); git('commit', '-am', 'no ranges');
  expect(() => preflight()).toThrow('E_HOST_ENGINE_REQUIREMENT: bun requires a valid engines range');
});

test('R1 operator path: argv0-sensitive symlink is executed and both paths recorded', () => {
  const canonical = join(dir, 'dispatcher');
  script(canonical, 'case "$0" in */bun) echo 1.4.4;; *) exit 8;; esac');
  rmSync(bun); symlinkSync(canonical, bun);
  const checked = preflight();
  expect(checked.engines.bun).toEqual({ path: bun, realPath: canonical, version: '1.4.4' });
});

test('R1 prerelease: engines use npm includePrerelease semantics', () => {
  script(bun, 'echo 1.5.0-canary.1'); script(node, 'echo v23.0.0-rc.1');
  expect(preflight().engines.bun.version).toBe('1.5.0-canary.1');
});

test('R1 lazy loading: source CLI works with pre-PR node_modules and no semver', () => {
  const checkout = join(dir, 'checkout'); mkdirSync(checkout);
  // Copy current source (including fixes under test), but only legacy dependencies.
  execFileSync('cp', ['-r', resolve('bin'), resolve('src'), resolve('package.json'), checkout]);
  const modules = join(checkout, 'node_modules'); mkdirSync(modules);
  for (const dep of ['mri', 'picocolors', 'prompts', 'kleur', 'sisteransi']) {
    symlinkSync(resolve('node_modules', dep), join(modules, dep));
  }
  const result = spawnSync(process.execPath, [join(checkout, 'bin/cook'), '--version'], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  expect(result.status).toBe(0); expect(result.stdout).toContain('connectome-cook 0.0.1');
});

for (const initial of [false, true]) test(`R1 reuse: transition ${initial ? 'selected to legacy' : 'legacy to selected'} rebuilds host and MCP`, () => {
  const mcp = join(dir, 'mcp'); mkdirSync(mcp); const mcpGit = (...args: string[]) => execFileSync('git', args, { cwd: mcp, stdio: 'pipe' });
  mcpGit('init', '-b', 'main'); mcpGit('config', 'user.name', 'Fixture'); mcpGit('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(mcp, 'file'), 'fixture'); mcpGit('add', '.'); mcpGit('commit', '-m', 'fixture');
  writeFileSync(recipe, JSON.stringify({ name: 'Fixture', agent: { systemPrompt: 'x' }, mcpServers: { fixture: { command: 'node', args: ['main.js'], source: { url: mcp, install: { kind: 'custom', run: 'echo built > build-marker', runtime: 'custom' } } } } }));
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH };
  const first = install(initial, env); expect(first.status).toBe(0);
  writeFileSync(join(out, 'app', 'stale'), 'stale');
  const mcpTarget = join(out, 'mcp'); expect(existsSync(join(mcpTarget, 'build-marker'))).toBe(true); writeFileSync(join(mcpTarget, 'stale'), 'stale');
  const second = install(!initial, env); expect(second.status).toBe(0);
  expect(existsSync(join(out, 'app', 'stale'))).toBe(false); expect(existsSync(join(mcpTarget, 'stale'))).toBe(false);
  expect(existsSync(join(mcpTarget, 'build-marker'))).toBe(true);
  const third = install(!initial, env); expect(third.status).toBe(0); expect(third.stdout).toContain('unchanged');
});

test('R1 scratch reuse: exactly one source fetch and local materialization', () => {
  const tools = join(dir, 'tools'); mkdirSync(tools); const trace = join(dir, 'git.trace');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  script(join(tools, 'git'), `printf '%s\\n' "$*" >> '${trace}'\nexec '${realGit}' "$@"`);
  const result = install(true, { ...process.env, PATH: tools + ':' + process.env.PATH });
  expect(result.status).toBe(0);
  const lines = readFileSync(trace, 'utf8').split('\n').filter(line => line.includes(repo) && /(?:^| )(fetch|clone|ls-remote) /.test(line));
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain('fetch');
});

test('R1 PATH: only bun and node exposed, unrelated tools retain precedence', () => {
  const tools = join(dir, 'tools'); mkdirSync(tools); script(join(tools, 'python3'), 'echo original');
  script(join(dir, 'python3'), 'echo shadow');
  // Ask the selected Bun build to inspect the real production build environment.
  script(bun, 'if [ "$1" = --version ]; then echo 1.4.4; else command -v bun > bun-path; command -v node > node-path; python3 > python-result; fi');
  const result = install(true, { ...process.env, PATH: tools + ':' + process.env.PATH }); expect(result.status).toBe(0);
  expect(readFileSync(join(out, 'app/python-result'), 'utf8').trim()).toBe('original');
  const bin = join(out, '.cook-engines/bin');
  expect(readdirSync(bin).sort()).toEqual(['bun', 'node']);
  expect(readFileSync(join(out, 'app/node-path'), 'utf8').trim()).toBe(join(bin, 'node'));
  expect(readFileSync(join(out, 'app/bun-path'), 'utf8').trim()).toBe(join(bin, 'bun'));
});

test('R1 role lookup: engine binding ignores clone array order', async () => {
  const host = await import('./backends/host.js');
  const actions = { clones: [
    { key: 'mcp', role: 'mcp' as const, url: repo, ref: 'main', target: '/mcp', buildCommand: 'make' },
    { key: 'host', role: 'connectome-host' as const, url: repo, ref: 'main', target: '/host', buildCommand: 'bun install' },
  ], copies: [], skipped: [], localExtensionPaths: new Map<string, string>() };
  host.bindHostEngine(actions, bun);
  expect(actions.clones[0]!.buildCommand).toBe('make');
  expect(actions.clones[1]!.buildCommand).toBe(`'${bun}' install`);
});

test('R1 pinned acquisition: --pin-refs does not look up the host twice', () => {
  const tools = join(dir, 'tools'); mkdirSync(tools); const trace = join(dir, 'git.trace');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  script(join(tools, 'git'), `printf '%s\\n' "$*" >> '${trace}'\nexec '${realGit}' "$@"`);
  const result = spawnSync(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--ch-ref', 'main', '--pin-refs', '--no-prompts', '--yes', '--bun-path', bun, '--node-path', node], { encoding: 'utf8', env: { ...process.env, PATH: tools + ':' + process.env.PATH } });
  expect(result.status).toBe(0);
  const lines = readFileSync(trace, 'utf8').split('\n').filter(line => line.includes(repo) && /(?:^| )(fetch|clone|ls-remote) /.test(line));
  expect(lines.length).toBe(1); expect(lines[0]).toContain('fetch');
});


for (const initial of [false, true]) test(`failed engine transition ${initial ? 'selected to legacy' : 'legacy to selected'} cannot reuse an old lock`, () => {
  const mcp = join(dir, 'mcp'); mkdirSync(mcp);
  execFileSync('git', ['init', '-b', 'main', mcp], { stdio: 'pipe' });
  execFileSync('git', ['-C', mcp, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'pipe' });
  const fail = join(dir, 'fail');
  writeFileSync(recipe, JSON.stringify({ name: 'Fixture', agent: { systemPrompt: 'x' }, mcpServers: { fixture: { command: 'node', source: { url: mcp, install: { kind: 'custom', run: `test ! -e '${fail}' && echo built > build-marker`, runtime: 'custom' } } } } }));
  // Distinguish the engines' installed dependency trees, not merely the launcher.
  const tools = join(dir, 'legacy-tools'); mkdirSync(tools);
  script(join(tools, 'bun'), 'echo legacy > engine-built');
  script(bun, 'if [ "$1" = --version ]; then echo 1.4.4; else echo selected > engine-built; fi');
  const env = { ...process.env, PATH: tools + ':' + process.env.PATH };
  expect(install(initial, env).status).toBe(0);
  writeFileSync(fail, 'fail');
  expect(install(!initial, env).status).toBe(3);
  expect(JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8')).incomplete).toBe(true);
  rmSync(fail);
  const retry = install(initial, env); expect(retry.status).toBe(0);
  expect(retry.stdout).not.toContain('unchanged');
  expect(readFileSync(join(out, 'app/engine-built'), 'utf8').trim()).toBe(initial ? 'selected' : 'legacy');
  expect(existsSync(join(out, '.cook-engines'))).toBe(initial);
});

for (const spelling of ['parent', 'dot']) test(`relative local host source (${spelling}) preserves the absolute legacy origin`, () => {
  const cwd = spelling === 'dot' ? dir : process.cwd();
  const local = spelling === 'dot' ? './repo' : relative(cwd, repo);
  let legacyOrigin = '';
  for (const flags of [false, true]) {
    const result = spawnSync(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', local, '--no-prompts', '--yes', ...(flags ? ['--bun-path', bun, '--node-path', node] : [])], { encoding: 'utf8', cwd, env: { ...process.env, PATH: dir + ':' + process.env.PATH } });
    expect(result.status).toBe(0);
    const origin = execFileSync('git', ['-C', join(out, 'app'), 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    if (!flags) legacyOrigin = origin;
    expect(origin).toBe(legacyOrigin);
    expect(resolve(origin)).toBe(repo);
    if (flags) expect(JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8')).connectomeHost.url).toBe(legacyOrigin);
    rmSync(out, { recursive: true });
  }
});

test('scp host:path stays a remote source rather than a local path', () => {
  const tools = join(dir, 'tools'); mkdirSync(tools); const trace = join(dir, 'git.trace');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  script(join(tools, 'git'), `case "$*" in *fetch*|*ls-remote*) printf '%s\\n' "$*" >> '${trace}'; exit 2;; esac\nexec '${realGit}' "$@"`);
  const old = process.env.PATH;
  try {
    process.env.PATH = tools + ':' + old;
    expect(() => selected.preflightHostEngines('fixture.invalid:repo', 'main', bun, node)).toThrow('E_HOST_ENGINE_REF:');
  } finally { process.env.PATH = old; }
  const lines = readFileSync(trace, 'utf8');
  expect(lines).toContain('-- fixture.invalid:repo main');
  expect(lines).not.toContain(resolve('fixture.invalid:repo'));
});

test('signalled git fetch reports TIMEOUT without leaking output or probing refs', () => {
  const tools = join(dir, 'tools'); mkdirSync(tools); const trace = join(dir, 'git.trace');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  script(join(tools, 'git'), `printf '%s\\n' "$*" >> '${trace}'\nif [ "$1" = fetch ] || [ "$2" = fetch ]; then echo SECRET_GIT_OUTPUT >&2; kill -TERM $$; fi\nexec '${realGit}' "$@"`);
  const result = install(true, { ...process.env, PATH: tools + ':' + process.env.PATH });
  expect(result.stderr).toContain('E_HOST_ENGINE_TIMEOUT:');
  expect(result.stderr).not.toContain('SECRET_GIT_OUTPUT');
  expect(readFileSync(trace, 'utf8')).not.toContain('ls-remote');
  expect(existsSync(out)).toBe(false);
});

test('inspected checkout drops synthetic refs and can fetch new upstream commits', () => {
  expect(install().status).toBe(0);
  const appGit = (...args: string[]) => execFileSync('git', ['-C', join(out, 'app'), ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  expect(appGit('remote', 'get-url', 'origin')).toBe(repo);
  expect(appGit('rev-parse', '--is-shallow-repository')).toBe('true');
  expect(spawnSync('git', ['-C', join(out, 'app'), 'symbolic-ref', '-q', 'HEAD']).status).not.toBe(0);
  expect(appGit('for-each-ref', '--format=%(refname)')).not.toContain('cook-selected');
  writeFileSync(join(repo, 'next'), 'new upstream commit'); git('add', '.'); git('commit', '-m', 'next');
  const next = git('rev-parse', 'HEAD'); appGit('fetch', 'origin');
  expect(appGit('rev-parse', 'refs/remotes/origin/main')).toBe(next);
  appGit('fetch', '--unshallow', 'origin');
  expect(appGit('rev-parse', '--is-shallow-repository')).toBe('false');
});

for (const phase of ['fetch', 'build']) for (const signal of ['SIGINT', 'SIGTERM'] as const) test(`scratch is removed on process-group ${signal} during host ${phase}`, async () => {
  const scratch = join(dir, 'scratch'); mkdirSync(scratch);
  const marker = join(dir, 'building');
  const tools = join(dir, 'tools'); mkdirSync(tools);
  if (phase === 'build') script(bun, `if [ "$1" = --version ]; then echo 1.4.4; else touch '${marker}'; sleep 30; fi`);
  else {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    script(join(tools, 'git'), `if [ "$1" = fetch ] || [ "$2" = fetch ]; then touch '${marker}'; exec sleep 30; fi\nexec '${realGit}' "$@"`);
  }
  const child = spawn(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--no-prompts', '--yes', '--bun-path', bun, '--node-path', node], { detached: true, stdio: 'ignore', env: { ...process.env, TMPDIR: scratch, PATH: tools + ':' + process.env.PATH } });
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    const deadline = Date.now() + 4000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(existsSync(marker)).toBe(true);
    expect(readdirSync(scratch).some(name => name.startsWith('cook-engines-'))).toBe(true);
    process.kill(-child.pid!, signal);
    const result = await exited;
    expect(result.signal).toBe(signal);
    expect(readdirSync(scratch)).toEqual([]);
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already exited */ }
    await exited;
  }
}, 10000);

test('colon install path is refused before preflight or writes for selected engines', () => {
  out = join(dir, 'unsafe:path');
  const result = install();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('E_HOST_ENGINE_PATH:');
  expect(result.stderr).toContain(':');
  expect(existsSync(out)).toBe(false);
  expect(() => selected.hostBuildPath('/unsafe:path/.cook-engines/bin', '/bin')).toThrow('E_HOST_ENGINE_PATH:');
});

test('engine help is scoped to builds and exact node commands; repo/ref stay adjacent', () => {
  const help = spawnSync(process.execPath, [resolve('bin/cook'), 'install', '--help'], { encoding: 'utf8' }).stdout;
  expect(help).toContain('Node for host builds and command: node servers');
  expect(help).toMatch(/--ch-repo[^\n]*\n  --ch-ref/);
});

test('selected logs describe inspected materialization and pinning without a second host lookup', () => {
  const result = spawnSync(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--pin-refs', '--no-prompts', '--yes', '--bun-path', bun, '--node-path', node], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('materializing inspected host');
  expect(result.stdout).toContain('pinning component refs (git ls-remote); host bound by engine preflight');
});

test('missing semver reports a coded refusal with a dependency install hint', () => {
  const checkout = join(dir, 'checkout'); mkdirSync(checkout);
  execFileSync('cp', ['-r', resolve('bin'), resolve('src'), resolve('package.json'), checkout]);
  const modules = join(checkout, 'node_modules'); mkdirSync(modules);
  for (const dep of ['mri', 'picocolors', 'prompts', 'kleur', 'sisteransi']) symlinkSync(resolve('node_modules', dep), join(modules, dep));
  const result = spawnSync(process.execPath, [join(checkout, 'bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--no-prompts', '--yes', '--bun-path', bun, '--node-path', node], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('E_HOST_ENGINE_DEPENDENCY:');
  expect(result.stderr).toContain('run bun install');
  expect(existsSync(out)).toBe(false);
});

for (const engine of ['bun', 'node'] as const) for (const observed of engine === 'bun' ? ['1.3.10', '1.4.5'] : ['20.0.0', '22.24.0']) test(`R3-1 directory shim ${engine} observes ${observed} in host and refuses before build`, () => {
  const caller = join(dir, 'caller'); mkdirSync(caller);
  writeFileSync(join(caller, '.tool-versions'), engine === 'bun' ? '1.4.4' : '22.23.3');
  const trace = join(dir, 'probes');
  script(engine === 'bun' ? bun : node, `p="$PWD"; v='${observed}'; while :; do
    if [ -f "$p/.tool-versions" ]; then v=$(cat "$p/.tool-versions"); break; fi
    [ "$p" = / ] && break; p=$(dirname "$p")
  done
  echo "$PWD $* $v" >> '${trace}'
  if [ "$1" = --version ]; then echo "$v"; else touch '${join(dir, 'built')}'; fi`);
  const result = spawnSync(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--no-prompts', '--yes', '--bun-path', bun, '--node-path', node], { cwd: caller, encoding: 'utf8' });
  expect(result.status).toBe(3);
  expect(result.stderr).toContain(observed === '1.3.10' || observed === '20.0.0' ? 'E_HOST_ENGINE_RANGE:' : 'E_HOST_ENGINE_CHANGED:');
  expect(readFileSync(trace, 'utf8')).toContain(`${join(out, 'app')} --version ${observed}`);
  expect(existsSync(join(dir, 'built'))).toBe(false);
  expect(existsSync(join(out, 'run.sh'))).toBe(false);
});

test('R3-4 failed ref reinstall preserves an incomplete lock, both run forms refuse, retry rebuilds', () => {
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH };
  expect(install(false, env).status).toBe(0);
  writeFileSync(join(out, 'app', 'stale'), 'stale');
  const failed = spawnSync(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--ch-ref', 'missing', '--no-prompts', '--yes'], { encoding: 'utf8', env });
  expect(failed.status).toBe(3);
  expect(existsSync(join(out, 'connectome.lock'))).toBe(true);
  expect(JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8')).incomplete).toBe(true);
  for (const args of [[out], [recipe, '--out', out]]) {
    const run = spawnSync(process.execPath, [resolve('bin/cook'), 'run', ...args], { encoding: 'utf8', env });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('last install failed; re-run `cook install`');
    expect(run.stdout).not.toContain('Write');
  }
  const retry = install(false, env); expect(retry.status).toBe(0);
  expect(retry.stdout).not.toContain('unchanged');
  expect(existsSync(join(out, 'app', 'stale'))).toBe(false);
  expect(JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8')).incomplete).toBeUndefined();
});

for (const withNextBuild of [true, false]) test(`R3-5 SIGTERM to cook alone stops before ${withNextBuild ? 'the next build' : 'lock publication'} and cleans scratch`, async () => {
  const scratch = join(dir, 'scratch'); mkdirSync(scratch);
  const marker = join(dir, 'building'), next = join(dir, 'next');
  script(bun, `if [ "$1" = --version ]; then echo 1.4.4; else touch '${marker}'; sleep 1; fi`);
  if (withNextBuild) writeFileSync(recipe, JSON.stringify({ name: 'Fixture', agent: { systemPrompt: 'x' }, mcpServers: { fixture: { command: 'node', source: { url: repo, install: { kind: 'custom', run: `touch '${next}'`, runtime: 'custom' } } } } }));
  const child = spawn(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--no-prompts', '--yes', '--bun-path', bun, '--node-path', node], { stdio: 'ignore', env: { ...process.env, TMPDIR: scratch } });
  const exited = new Promise<string | null>(r => child.on('exit', (_code, signal) => r(signal)));
  try {
    const deadline = Date.now() + 4000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    expect(existsSync(marker)).toBe(true);
    process.kill(child.pid!, 'SIGTERM');
    expect(await exited).toBe('SIGTERM');
    expect(existsSync(next)).toBe(false);
    expect(existsSync(join(out, 'connectome.lock'))).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  } finally { try { child.kill('SIGKILL'); } catch {} await exited; }
}, 10000);

test('R3-2 absolute GIT_DIR and repository-local variables never touch an unrelated repository', () => {
  const unrelated = join(dir, 'unrelated');
  execFileSync('git', ['init', unrelated], { stdio: 'pipe' });
  const before = execFileSync('find', [unrelated, '-type', 'f', '-exec', 'sha256sum', '{}', '+'], { encoding: 'utf8' });
  const env = { ...process.env, GIT_DIR: join(unrelated, '.git'), GIT_WORK_TREE: unrelated, GIT_INDEX_FILE: join(unrelated, 'index') };
  // Both pre-confirm inspection and every clone follow-up are exercised.
  const refused = spawnSync(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--no-prompts', '--bun-path', bun, '--node-path', node], { encoding: 'utf8', env });
  expect(refused.status).toBe(1); expect(existsSync(out)).toBe(false);
  const result = install(true, env); expect(result.status).toBe(0);
  const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
  expect(lock.connectomeHost.commit).toBe(git('rev-parse', 'HEAD'));
  expect(execFileSync('git', ['-C', join(out, 'app'), 'for-each-ref'], { encoding: 'utf8' })).not.toContain('cook-selected');
  expect(execFileSync('find', [unrelated, '-type', 'f', '-exec', 'sha256sum', '{}', '+'], { encoding: 'utf8' })).toBe(before);
});

test('R3-3 reviewer template cannot overwrite selected node, even before confirmation', () => {
  const original = readFileSync(node, 'utf8');
  writeFileSync(recipe, JSON.stringify({ name: 'Fixture', agent: { systemPrompt: 'x' }, containerTemplateFiles: [{ hostPath: 't.tmpl', inContainer: '/.cook-engines/bin/node', template: 'hello-template' }] }));
  const result = install();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('E_HOST_ENGINE_RESERVED:');
  expect(result.stdout).not.toContain('Host install plan');
  expect(existsSync(out)).toBe(false);
  expect(readFileSync(node, 'utf8')).toBe(original);
});

for (const config of ['safe.bareRepository=explicit', 'clone.defaultRemoteName=upstream', 'clone.rejectShallow=true']) test(`R3-6 git ${config} permits selected install`, () => {
  const configFile = join(dir, 'gitconfig');
  const [key, value] = config.split('=');
  execFileSync('git', ['config', '--file', configFile, key!, value!]);
  const result = install(true, { ...process.env, GIT_CONFIG_GLOBAL: configFile });
  expect(result.status).toBe(0);
  expect(execFileSync('git', ['-C', join(out, 'app'), 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()).toBe(repo);
});

test('R3-6 SHA-256 host repositories refuse with an explicit unsupported error', () => {
  rmSync(repo, { recursive: true }); mkdirSync(repo);
  git('init', '--object-format=sha256', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ engines: { bun: '*', node: '*' } }));
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'sha256');
  const result = install();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('E_HOST_ENGINE_OBJECT_FORMAT: SHA-256 host repositories are unsupported');
  expect(existsSync(out)).toBe(false);
});

for (const size of [40, 64]) test(`R3-7 unadvertised full ${size}-hex SHA stays FETCH without a ref probe`, () => {
  const tools = join(dir, 'tools'); mkdirSync(tools); const trace = join(dir, 'git.trace');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  script(join(tools, 'git'), `echo "$*" >> '${trace}'
    if [ "$2" = fetch ]; then exit 1; fi
    if [ "$2" = ls-remote ]; then exit 2; fi
    exec '${realGit}' "$@"`);
  const old = process.env.PATH;
  try {
    process.env.PATH = tools + ':' + old;
    expect(() => preflight('a'.repeat(size))).toThrow('E_HOST_ENGINE_FETCH:');
  } finally { process.env.PATH = old; }
  expect(readFileSync(trace, 'utf8')).not.toContain('ls-remote');
});

test('R3-4 declining a changed install leaves the prior lock unmarked', () => {
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH };
  expect(install(false, env).status).toBe(0);
  const before = readFileSync(join(out, 'connectome.lock'), 'utf8');
  const result = spawnSync(process.execPath, [resolve('bin/cook'), 'install', recipe, '--out', out, '--ch-repo', repo, '--ch-ref', 'missing', '--no-prompts'], { encoding: 'utf8', env });
  expect(result.status).toBe(1);
  expect(readFileSync(join(out, 'connectome.lock'), 'utf8')).toBe(before);
});

test('R3-1 lock records the engine observed from the host, not the preflight canonical path', () => {
  const first = join(dir, 'first'), second = join(dir, 'second');
  script(second, 'if [ "$1" = --version ]; then echo 1.4.4; else echo built > builds; fi');
  script(first, `echo 1.4.4; ln -sf '${second}' '${bun}'`);
  rmSync(bun); symlinkSync(first, bun);
  const result = install(); expect(result.status).toBe(0);
  const lock = JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8'));
  expect(lock.engines.bun).toEqual({ path: bun, realPath: second, version: '1.4.4' });
  expect(lock.engines.node.version).toBe('22.23.3');
});

test('R3-7 failed component build change marks the lock and retry rebuilds the previously reused host', () => {
  const fail = join(dir, 'fail');
  const writeRecipe = (run: string) => writeFileSync(recipe, JSON.stringify({ name: 'Fixture', agent: { systemPrompt: 'x' }, mcpServers: { fixture: { command: 'node', source: { url: repo, install: { kind: 'custom', run, runtime: 'custom' } } } } }));
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH };
  writeRecipe('echo old > built'); expect(install(false, env).status).toBe(0);
  writeFileSync(join(out, 'app', 'stale'), 'stale'); writeFileSync(fail, 'fail');
  writeRecipe(`test ! -e '${fail}' && echo new > built`);
  expect(install(false, env).status).toBe(3);
  expect(JSON.parse(readFileSync(join(out, 'connectome.lock'), 'utf8')).incomplete).toBe(true);
  rmSync(fail);
  const retry = install(false, env); expect(retry.status).toBe(0);
  expect(retry.stdout).not.toContain('unchanged');
  expect(existsSync(join(out, 'app', 'stale'))).toBe(false);
  expect(readFileSync(join(out, 'repo', 'built'), 'utf8').trim()).toBe('new');
});
