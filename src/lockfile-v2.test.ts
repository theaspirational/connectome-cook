import { afterEach, expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runDockerBackend } from './backends/docker.js';
import { resolvePlan } from './plan.js';
import { spawnSync } from 'node:child_process';
import { buildId, createOutputHasher, deploymentRecord, fullCommit, outputRecords, sha256, writeLockfile, type LockfileV2, readLockfile } from './lockfile.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const SHA = 'a'.repeat(40);

test('docker writer emits v2 and never serializes arbitrary requirement answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cook-lock-v2-')); dirs.push(dir);
  const recipe = join(dir, 'recipe.json');
  writeFileSync(recipe, JSON.stringify({ name: 'lock test', agent: { provider: 'openai-codex', systemPrompt: 'test' } }));
  const result = await resolvePlan(recipe, { strict: false, noPrompts: true });
  if (!result.ok) throw new Error('plan failed');
  for (let i = 0; i < 25; i++) {
    const value = `synthetic-secret-${i}-\"\\\n${String.fromCodePoint(0x100 + i)}`;
    result.plan.requirements.push({ name: `req${i}`, envName: `VAR${i}`, value, origin: 'process-env', required: true, declaredIn: [recipe] });
    const outDir = join(dir, 'out');
    expect((await runDockerBackend(result.plan, { outDir, noPrompts: true, strict: false, pinRefs: true, pinnedChRef: SHA, allowIncompleteTemplates: false })).exitCode).toBe(0);
    const raw = readFileSync(join(outDir, 'connectome.lock'), 'utf8');
    expect(JSON.parse(raw).requirements[0]).not.toHaveProperty('value');
    expect(raw).not.toContain(JSON.stringify(value).slice(1, -1));
    expect(readLockfile(outDir)?.version).toBe(2);
  }
});

// All acquisition tools are suite-owned stubs; neither backend can reach a
// registry/remote during these integration tests.
function fixture(recipeName = 'recipe.json') {
  const dir = mkdtempSync(join(tmpdir(), 'cook-v2-cli-')); dirs.push(dir);
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const gitLog = join(dir, 'git-log');
  const npmLog = join(dir, 'npm-log');
  const dockerLog = join(dir, 'docker-log');
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
import { appendFileSync, mkdirSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'ls-remote') console.log(process.env.TEST_SHA + '\\t' + args[2]);
if (args[0] === 'rev-parse') {
  if (process.env.TEST_MISSING_HEAD) process.exit(1);
  console.log(process.env.TEST_SHA);
}
if (args[0] === 'clone') mkdirSync(args[2], { recursive: true });
`, { mode: 0o755 });
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // Legacy metadata lets the red-before probe reach unrelated findings;
  // the fixed writer must not invoke this stub at all.
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' \"$*\" >> '${npmLog}'\nprintf '%s\\n' '{"name":"@scope/pkg","version":"1.2.3","dist.integrity":"sha512-YWJjZA=="}'\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' \"$*\" >> '${dockerLog}'\nexit \"\${TEST_DOCKER_EXIT:-0}\"\n`, { mode: 0o755 });
  const recipe = join(dir, recipeName);
  writeFileSync(recipe, JSON.stringify({
    name: 'Lock v2 fixture', agent: { systemPrompt: 'Test ${ODD_ANSWER}' },
    requirements: { arbitrary: { exposeAs: 'ODD_ANSWER' } },
    mcpServers: {
      git: { command: 'node', args: ['index.js'], source: { url: 'https://example.invalid/git.git', install: { run: '', runtime: 'node' } } },
      npm: { command: 'npx', args: ['-y', '@scope/pkg@1.2.3'], source: { npm: '@scope/pkg@1.2.3' },
        credentialFiles: [{ path: './.credential', format: 'json', fields: [{ name: 'token', envOverride: 'CRED_TOKEN', secret: true }] }] },
    },
    services: [{ name: 'kv', image: 'example/kv:1', volumes: [{ source: './config', target: '/etc/kv' }], secrets: ['SIDECAR_SECRET'],
      templateFiles: [{ path: 'config/kv.conf', template: 'secret=${ODD_ANSWER}', mode: '600' }] }],
  }, null, 2) + '\n');
  const out = join(dir, 'out');
  const canary = 'synthetic-private-answer';
  const env = {
    PATH: `${bin}:${process.env.PATH}`, HOME: dir, NO_UPDATE_NOTIFIER: '1',
    TEST_SHA: SHA,
    // The acquisition stubs use explicit parent-only test inputs under #11.
    COOK_PASS_ENV: 'TEST_SHA TEST_MISSING_HEAD',
    ANTHROPIC_API_KEY: canary, ODD_ANSWER: canary, CRED_TOKEN: canary, SIDECAR_SECRET: canary,
  };
  const cli = (args: string[], extra: Record<string, string> = {}, preload?: string) => spawnSync(process.execPath, [
    ...(preload ? ['--preload', preload] : []), join(import.meta.dir, '../bin/cook'), ...args,
  ], { env: { ...env, ...extra }, encoding: 'utf8' });
  const run = (backend: 'docker' | 'host', extra: Record<string, string> = {}, pin = true, preload?: string) => spawnSync(process.execPath, [
    ...(preload ? ['--preload', preload] : []), join(import.meta.dir, '../bin/cook'), backend === 'docker' ? 'build' : 'install', recipe,
    '--out', out, '--no-prompts', '--yes', ...(pin ? ['--pin-refs'] : []),
  ], { env: { ...env, ...extra }, encoding: 'utf8' });
  const lock = () => readLockfile(out) as LockfileV2;
  return { dir, recipe, out, run, lock, canary, gitLog, npmLog, dockerLog, cli };
}

for (const backend of ['docker', 'host'] as const) {
  test(`${backend}: prompt answers and accepted probe defaults suppress public hashes`, () => {
    for (const source of ['prompt', 'probe'] as const) {
      const f = fixture();
      const answer = source === 'probe' ? join(f.dir, 'probe-default') : f.canary;
      if (source === 'probe') mkdirSync(answer);
      const recipe = JSON.parse(readFileSync(f.recipe, 'utf8'));
      recipe.services[0].environment = { LITERAL: answer };
      recipe.requirements.arbitrary.probe = source === 'probe' ? [answer] : [];
      writeFileSync(f.recipe, JSON.stringify(recipe));
      const preload = join(f.dir, 'answers.ts');
      writeFileSync(preload, `import prompts from ${JSON.stringify(join(import.meta.dir, '../node_modules/prompts/index.js'))};
        prompts.inject([${JSON.stringify(answer)}, true]);`);
      const result = f.cli([backend === 'docker' ? 'build' : 'install', f.recipe,
        '--out', f.out, '--yes', '--pin-refs', ...(source === 'probe' ? ['--no-prompts'] : [])],
        { ODD_ANSWER: '' }, preload);
      if (result.status !== 0 || !f.lock()) throw new Error(result.stdout + result.stderr);
      expect(f.lock().requirements[0]?.origin).toBe(source);
      for (const path of ['recipes/recipe.json', backend === 'docker' ? 'docker-compose.yml' : 'docker-compose.sidecars.yml']) {
        const output = f.lock().outputs.find(o => o.path === path)!;
        expect(output.sha256).toBeUndefined();
        expect(output).toHaveProperty('sha256Omitted', 'contains-requirement-value');
      }
    }
  });

  test(`${backend}: one-character answers match; empty optional answers do not suppress ordinary outputs`, () => {
    for (const answer of ['λ', '']) {
      const f = fixture();
      const recipe = JSON.parse(readFileSync(f.recipe, 'utf8'));
      recipe.requirements.arbitrary.required = false;
      recipe.services[0].environment = { LITERAL: answer };
      // Avoid unresolved runtime template vars in the empty-answer case.
      recipe.services[0].templateFiles[0].template = 'ordinary template';
      recipe.agent.systemPrompt = 'ordinary prompt';
      writeFileSync(f.recipe, JSON.stringify(recipe));
      const result = f.run(backend, { ODD_ANSWER: answer });
      if (result.status !== 0) throw new Error(result.stderr);
      for (const path of ['recipes/recipe.json', backend === 'docker' ? 'docker-compose.yml' : 'docker-compose.sidecars.yml']) {
        const output = f.lock().outputs.find(o => o.path === path)!;
        if (answer) {
          expect(output.sha256).toBeUndefined();
          expect(output).toHaveProperty('sha256Omitted', 'contains-requirement-value');
        } else {
          expect(output.sha256).toBe(sha256(readFileSync(join(f.out, path))));
          expect(output).not.toHaveProperty('sha256Omitted');
        }
      }
    }
  });

  for (const location of ['environment', 'template'] as const) {
    for (const escaped of [false, true]) {
      test(`${backend}: public ${location} omits answer verifiers (${escaped ? 'escaped' : 'literal'})`, () => {
        for (const source of (escaped ? ['process-env'] : ['process-env', 'env-file'])) {
          const f = fixture();
          const answer = escaped ? 'private-"\\\n\t-dollar$-quote\'' : f.canary;
          const recipe = JSON.parse(readFileSync(f.recipe, 'utf8'));
          if (location === 'environment') recipe.services[0].environment = { LITERAL: `prefix:${answer}:suffix` };
          else recipe.services[0].templateFiles[0].template = `literal=${answer}`;
          writeFileSync(f.recipe, JSON.stringify(recipe));
          const envFile = join(f.dir, 'answers.env');
          // This parser preserves bare backslashes; multiline values are not
          // supported by env-file, so use the env source for that variant.
          const fromFile = source === 'env-file';
          if (fromFile) writeFileSync(envFile, `ODD_ANSWER=${answer}\n`);
          const result = f.cli([backend === 'docker' ? 'build' : 'install', f.recipe,
            '--out', f.out, '--no-prompts', '--yes', '--pin-refs',
            ...(fromFile ? ['--env-file', envFile] : [])], { ODD_ANSWER: fromFile ? 'superseded-answer' : answer });
          if (result.status !== 0) throw new Error(result.stderr);
          const lock = f.lock();
          expect(lock.requirements[0]?.origin).toBe(fromFile ? 'env-file' : 'process-env');
          const output = lock.outputs.find(o => o.path === 'recipes/recipe.json')!;
          expect(output.sha256).toBeUndefined();
          expect(output).toHaveProperty('sha256Omitted', 'contains-requirement-value');
          if (location === 'environment') {
            const compose = lock.outputs.find(o => o.path === (backend === 'docker' ? 'docker-compose.yml' : 'docker-compose.sidecars.yml'))!;
            expect(compose).toBeDefined();
            expect(compose.sha256).toBeUndefined();
            expect(compose).toHaveProperty('sha256Omitted', 'contains-requirement-value');
          }
          // Every raw/JSON/YAML occurrence is suppressed, not just the
          // particular output that triggered the review finding.
          const forms = [answer, JSON.stringify(answer).slice(1, -1), answer.replace(/\\/g, '\\\\').replace(/"/g, '\\"')];
          for (const o of lock.outputs) {
            const bytes = readFileSync(join(f.out, o.path), 'utf8');
            if (forms.some(form => bytes.includes(form))) expect(o.sha256).toBeUndefined();
          }
          expect(lock.outputs.find(o => o.path === (backend === 'docker' ? 'entrypoint.sh' : 'run.sh'))?.sha256).toBeDefined();
          // Owner decision A deliberately retains input identity, even when
          // the operator put the same answer literally in the recipe.
          expect(lock.recipe.sha256).toBe(sha256(readFileSync(f.recipe)));
          expect(lock.build.id).toMatch(/^[a-f0-9]{64}$/);
        }
      });
    }
  }

  test(`${backend}: v2 writer/reader, output digests/modes, npm inventory, credential names, stable identity`, () => {
    const f = fixture();
    const first = f.run(backend);
    expect(first.stderr).not.toContain('failed');
    expect(first.status).toBe(0);
    const lock = f.lock();
    expect(lock.version).toBe(2);
    expect(lock.cook.version).toBe('0.0.1');
    expect(lock.recipe).toEqual({ path: f.recipe, sha256: sha256(readFileSync(f.recipe)) });
    expect(lock.connectomeHost.commit).toBe(SHA);
    expect(lock.components.find(c => c.kind === 'git')?.commit).toBe(SHA);
    expect(lock.components.find(c => c.kind === 'npm')).toEqual({
      kind: 'npm', key: 'npm:@scope/pkg@1.2.3', role: 'mcp', name: '@scope/pkg', spec: '@scope/pkg@1.2.3', version: '1.2.3',
    });
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ODD_ANSWER', 'CRED_TOKEN', 'SIDECAR_SECRET']) {
      expect(lock.credentials).toContain(name);
    }
    expect(lock.build.dir).toBe(f.out);
    expect(lock.build.id).toMatch(/^[a-f0-9]{64}$/);
    expect(lock.state).toBeUndefined();
    const raw = readFileSync(join(f.out, 'connectome.lock'), 'utf8');
    expect(raw).not.toContain(f.canary);
    expect(lock.requirements[0]).not.toHaveProperty('value');
    const launcher = backend === 'host' ? 'run.sh' : 'entrypoint.sh';
    expect(lock.outputs.some(o => o.path === launcher && o.mode === 0o755 && o.sha256)).toBe(true);
    expect(lock.outputs.some(o => o.path === 'recipes/recipe.json' && o.sha256)).toBe(true);
    expect(lock.outputs.find(o => o.path === '.env')?.sha256).toBeUndefined();
    expect(lock.outputs.find(o => o.path === 'config/kv.conf')?.sha256).toBeUndefined();
    expect(lock.outputs.find(o => o.path === 'SIDECAR_SECRET')?.sha256).toBeUndefined();
    for (const output of lock.outputs) {
      expect(output.mode).toBe(statSync(join(f.out, output.path)).mode & 0o777);
      if (output.sha256) expect(output.sha256).toBe(sha256(readFileSync(join(f.out, output.path))));
    }
    // A value rotation and timestamp are not immutable build inputs.
    expect(f.run(backend, { ODD_ANSWER: 'rotated-private-answer' }).status).toBe(0);
    expect(f.lock().build.id).toBe(lock.build.id);
    expect(f.run(backend, { TEST_SHA: 'b'.repeat(40) }).status).toBe(0);
    expect(f.lock().build.id).not.toBe(lock.build.id);
  });

  test(`${backend}: legacy v1 accepted, next materialization rewrites v2; unknown refused by reader`, () => {
    const f = fixture();
    expect(f.run(backend).status).toBe(0);
    const current = f.lock();
    const legacy = {
      version: 1, backend, recipePath: current.recipePath, createdAt: current.createdAt,
      connectomeHost: { ...current.connectomeHost, commit: undefined },
      components: current.components.filter(c => c.kind === 'git').map(({ kind: _kind, commit: _commit, ...c }) => c),
      localExtensions: current.localExtensions, launch: current.launch,
      requirements: [{ name: 'arbitrary', envName: 'ODD_ANSWER', origin: 'process-env', value: f.canary }],
    };
    writeFileSync(join(f.out, 'connectome.lock'), JSON.stringify(legacy));
    expect(readLockfile(f.out)?.version).toBe(1);
    const before = readFileSync(f.gitLog, 'utf8');
    expect(f.run(backend, {}, backend === 'docker').status).toBe(0);
    expect(f.lock().version).toBe(2);
    expect(f.lock().connectomeHost.commit).toBe(SHA);
    expect(readFileSync(join(f.out, 'connectome.lock'), 'utf8')).not.toContain(f.canary);
    if (backend === 'host') {
      const next = readFileSync(f.gitLog, 'utf8').slice(before.length);
      expect(next).not.toContain('clone');
      expect(next).toContain('rev-parse');
    }
    writeFileSync(join(f.out, 'connectome.lock'), '{"version":999}');
    expect(() => readLockfile(f.out)).toThrow(/unsupported lockfile version 999/);
    if (backend === 'host') {
      expect(f.run(backend).status).not.toBe(0);
      expect(readFileSync(join(f.out, 'connectome.lock'), 'utf8')).toBe('{"version":999}');
    }
  });

  test(`${backend}: property-style arbitrary requirement values never reach the lock`, () => {
    const f = fixture();
    const recipe = JSON.parse(readFileSync(f.recipe, 'utf8'));
    const answers: Record<string, string> = {};
    for (let i = 0; i < 32; i++) {
      const name = `UNCLASSIFIED_${i}`;
      recipe.requirements[`r${i}`] = { exposeAs: name };
      answers[name] = `value-${i}-\"\\\n-${String.fromCodePoint(0x100 + i)}`;
    }
    writeFileSync(f.recipe, JSON.stringify(recipe));
    expect(f.run(backend, answers).status).toBe(0);
    const raw = readFileSync(join(f.out, 'connectome.lock'), 'utf8');
    expect(f.lock().requirements).toHaveLength(33);
    for (const r of f.lock().requirements) expect(r).not.toHaveProperty('value');
    for (const value of Object.values(answers)) expect(raw).not.toContain(JSON.stringify(value).slice(1, -1));
  });

  test(`${backend}: npm declarations accept exact versions, tags and ranges without metadata or registry calls`, () => {
    for (const spec of ['@scope/pkg@1.2.3', '@scope/pkg@next', '@scope/pkg@^1.2.0', 'pkg', 'pkg@~2', 'pkg@1.2.3-01', 'pkg@1.2.3-..', 'pkg@2.0.0-rc.1+build']) {
      const f = fixture();
      const recipe = JSON.parse(readFileSync(f.recipe, 'utf8'));
      recipe.mcpServers.npm.source.npm = spec;
      writeFileSync(f.recipe, JSON.stringify(recipe));
      expect(f.run(backend).status).toBe(0);
      const npm = f.lock().components.find(c => c.kind === 'npm');
      expect(npm).toEqual({ kind: 'npm', key: `npm:${spec}`, role: 'mcp',
        name: spec.startsWith('@') ? '@scope/pkg' : 'pkg', spec,
        ...(spec.endsWith('@1.2.3') ? { version: '1.2.3' } : {}),
        ...(spec.endsWith('@2.0.0-rc.1+build') ? { version: '2.0.0-rc.1+build' } : {}),
      });
      expect(existsSync(f.npmLog)).toBe(false);
    }
  });
}

test('docker default build and run fallback retain main exit codes without invented provenance', () => {
  const f = fixture();
  expect(f.run('docker', {}, false).status).toBe(0);
  expect(f.lock().connectomeHost).not.toHaveProperty('commit');
  expect(f.lock().components.find(c => c.kind === 'git')).not.toHaveProperty('commit');
  expect(existsSync(f.gitLog)).toBe(false);
  for (const status of [0, 17]) {
    rmSync(f.out, { recursive: true });
    expect(f.cli(['run', f.recipe, '--out', f.out, '--no-prompts'], { TEST_DOCKER_EXIT: String(status) }).status).toBe(status);
    expect(f.lock().version).toBe(2);
  }
  expect(readFileSync(f.dockerLog, 'utf8').trim().split('\n')).toEqual(['compose up --build', 'compose up --build']);
  expect(f.cli(['build', join(f.dir, 'missing.json'), '--no-prompts']).status).toBe(2);
  expect(f.cli(['run', join(f.dir, 'missing.json'), '--no-prompts']).status).toBe(2);
});

for (const backend of ['docker', 'host'] as const) {
  for (const alias of ['private-symlink', 'template-symlink', 'hardlink', 'directory-symlink'] as const) {
    test(`${backend}: filesystem output alias ${alias} never puts a secret digest in the lock`, () => {
      for (const previous of [false, true]) {
        const f = fixture();
        if (previous) expect(f.run(backend).status).toBe(0);
        const lockPath = join(f.out, 'connectome.lock');
        mkdirSync(join(f.out, 'private'), { recursive: true });
        mkdirSync(join(f.out, 'config'), { recursive: true });
        mkdirSync(join(f.out, 'recipes'), { recursive: true });
        const publicPath = alias === 'private-symlink'
          ? join(f.out, backend === 'docker' ? 'README.md' : 'run.sh')
          : join(f.out, 'recipes/recipe.json');
        const secretPath = join(f.out, alias === 'private-symlink' ? 'private/secret' : 'config/kv.conf');
        writeFileSync(secretPath, f.canary);
        if (alias === 'private-symlink') {
          const recipe = JSON.parse(readFileSync(f.recipe, 'utf8'));
          recipe.services[0].volumes.push({ source: './private', target: '/etc/private' });
          recipe.services[0].templateFiles.push({ path: 'private/secret', template: 'secret=${ODD_ANSWER}', mode: '600' });
          writeFileSync(f.recipe, JSON.stringify(recipe));
        }
        if (alias === 'directory-symlink') {
          rmSync(join(f.out, 'recipes'), { recursive: true });
          symlinkSync('config', join(f.out, 'recipes'));
        } else {
          rmSync(publicPath, { force: true });
          if (alias === 'hardlink') linkSync(secretPath, publicPath);
          else symlinkSync(secretPath, publicPath);
        }
        const result = f.run(backend);
        if (result.status !== 0) throw new Error(result.stderr);
        const raw = readFileSync(lockPath, 'utf8');
        // Writes through aliases remain main's behavior; only the lock's
        // provenance is under test, not the resulting on-disk secret file.
        const actual = readFileSync(secretPath, 'utf8');
        if (actual.includes(f.canary)) expect(raw).not.toContain(sha256(actual));
        expect(raw).not.toContain(sha256(f.canary));
        expect(raw).not.toContain(sha256(`secret=${f.canary}`));
      }
    });
  }

  test(`${backend}: sensitive links, dangling links and a linked output root remain secret-safe`, () => {
    for (const alias of ['sensitive-symlink', 'sensitive-hardlink', 'dangling-symlink', 'root-symlink']) {
      const f = fixture();
      const secretPath = join(f.dir, 'private-secret');
      writeFileSync(secretPath, f.canary);
      if (alias === 'root-symlink') {
        const target = join(f.dir, 'target'); mkdirSync(target);
        symlinkSync(target, f.out);
      } else {
        mkdirSync(f.out);
        if (alias === 'sensitive-hardlink') linkSync(secretPath, join(f.out, '.env'));
        else symlinkSync(alias === 'dangling-symlink' ? 'missing' : secretPath, join(f.out, '.env'));
      }
      const result = f.run(backend);
      if (result.status !== 0) throw new Error(result.stderr);
      const raw = readFileSync(join(f.out, 'connectome.lock'), 'utf8');
      expect(raw).not.toContain(f.canary);
      expect(raw).not.toContain(sha256(f.canary));
      expect(raw).not.toContain(sha256(readFileSync(join(f.out, '.env'))));
      expect(f.lock().outputs.find(o => o.path === '.env')?.sha256).toBeUndefined();
    }
  });

  for (const attack of ['after-write', 'stat-race', 'ancestor-race'] as const) {
    test(`${backend}: ${attack} cannot replace generated provenance with a secret digest`, () => {
      const f = fixture();
      const publicPath = join(f.out, backend === 'docker' ? 'README.md' : 'run.sh');
      const secretPath = join(f.dir, 'private-secret');
      writeFileSync(secretPath, f.canary);
      const preload = join(f.dir, 'attack.ts');
      const captured = join(f.dir, 'generated-bytes');
      // Isolated fs hooks deterministically inject races at the old trust
      // boundaries, without relying on timing or contaminating other tests.
      writeFileSync(preload, `
        import { mock } from 'bun:test';
        import * as fs from 'node:fs';
        const originalWrite = fs.writeFileSync;
        const publicPath = ${JSON.stringify(publicPath)};
        const secretPath = ${JSON.stringify(secretPath)};
        const out = ${JSON.stringify(f.out)};
        const attack = ${JSON.stringify(attack)};
        let swapped = false;
        const swap = () => {
          if (swapped) return;
          swapped = true;
          if (attack === 'ancestor-race') {
            const replacement = out + '-replacement';
            fs.mkdirSync(replacement);
            fs.symlinkSync(secretPath, replacement + '/' + publicPath.split('/').at(-1));
            fs.renameSync(out, out + '-original');
            fs.symlinkSync(replacement, out);
          } else {
            fs.unlinkSync(publicPath);
            fs.symlinkSync(secretPath, publicPath);
          }
        };
        const stat = (fn) => (...args) => {
          const result = fn(...args);
          if (String(args[0]) === publicPath && attack !== 'after-write') swap();
          return result;
        };
        mock.module('node:fs', () => ({ ...fs,
          lstatSync: stat(fs.lstatSync), statSync: stat(fs.statSync),
          writeFileSync: (...args) => {
            if (String(args[0]) === publicPath) originalWrite(${JSON.stringify(captured)}, args[1]);
            const result = originalWrite(...args);
            if (String(args[0]) === publicPath && attack === 'after-write') swap();
            return result;
          },
        }));
      `);
      const result = f.run(backend, {}, true, preload);
      if (result.status !== 0) throw new Error(result.stderr);
      const raw = readFileSync(join(f.out, 'connectome.lock'), 'utf8');
      expect(raw).not.toContain(f.canary);
      expect(raw).not.toContain(sha256(f.canary));
      // The public digest still describes cook's bytes, not the injected file.
      expect(f.lock().outputs.find(o => resolve(f.out, o.path) === publicPath)?.sha256)
        .toBe(sha256(readFileSync(captured)));
    });
  }

  test(`${backend}: symlinked output ancestor never leaks a template digest`, () => {
    const f = fixture();
    const target = join(f.dir, 'target'); mkdirSync(target);
    const ancestor = join(f.dir, 'ancestor'); symlinkSync(target, ancestor);
    const out = join(ancestor, 'out');
    mkdirSync(join(out, 'recipes'), { recursive: true });
    mkdirSync(join(out, 'config'));
    writeFileSync(join(out, 'config/kv.conf'), f.canary);
    symlinkSync('../config/kv.conf', join(out, 'recipes/recipe.json'));
    const result = f.cli([backend === 'docker' ? 'build' : 'install', f.recipe,
      '--out', out, '--no-prompts', '--yes', '--pin-refs']);
    if (result.status !== 0) throw new Error(result.stderr);
    const raw = readFileSync(join(out, 'connectome.lock'), 'utf8');
    expect(raw).not.toContain(f.canary);
    expect(raw).not.toContain(sha256(f.canary));
    expect(raw).not.toContain(sha256(`secret=${f.canary}`));
  });

  test(`${backend}: sensitive output aliases win over public inventory without a secret hash anywhere`, () => {
    const f = fixture(backend === 'host' ? 'host.json' : 'recipe.json');
    const recipe = JSON.parse(readFileSync(f.recipe, 'utf8'));
    const path = backend === 'docker' ? './README.md' : './recipes/host.json';
    recipe.services[0].volumes.push({ source: path, target: '/etc/alias' });
    recipe.services[0].templateFiles.push({ path, template: 'secret=${ODD_ANSWER}', mode: '600' });
    writeFileSync(f.recipe, JSON.stringify(recipe));
    const result = f.run(backend);
    if (result.status !== 0) throw new Error(result.stderr);
    expect(result.status).toBe(0);
    const raw = readFileSync(join(f.out, 'connectome.lock'), 'utf8');
    const normalized = path.slice(2);
    const outputs = f.lock().outputs.filter(o => resolve(f.out, o.path) === resolve(f.out, path));
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toEqual({ path: normalized, mode: statSync(join(f.out, path)).mode & 0o777 });
    expect(raw).not.toContain(f.canary);
    expect(raw).not.toContain(sha256(readFileSync(join(f.out, path))));
    expect(raw).not.toContain(sha256(`secret=${f.canary}`));
  });

  test(`${backend}: relocating an identical recipe tree and output keeps identity`, () => {
    const f = fixture();
    const recipe = JSON.parse(readFileSync(f.recipe, 'utf8'));
    recipe.modules = { fleet: { children: [{ name: 'child', recipe: './nested/child.json' }] } };
    mkdirSync(join(f.dir, 'nested'));
    const child = JSON.stringify({ name: 'child', agent: { systemPrompt: 'child' } });
    writeFileSync(join(f.dir, 'nested/child.json'), child);
    writeFileSync(f.recipe, JSON.stringify(recipe));
    expect(f.run(backend).status).toBe(0);
    const first = f.lock().build.id;
    const moved = join(f.dir, 'moved'); mkdirSync(join(moved, 'nested'), { recursive: true });
    writeFileSync(join(moved, 'recipe.json'), JSON.stringify(recipe));
    writeFileSync(join(moved, 'nested/child.json'), child);
    const out = join(moved, 'bundle');
    const args = [backend === 'docker' ? 'build' : 'install', join(moved, 'recipe.json'), '--out', out, '--no-prompts', '--yes', '--pin-refs'];
    expect(f.cli(args).status).toBe(0);
    expect((readLockfile(out) as LockfileV2).build.id).toBe(first);
    writeFileSync(join(moved, 'nested/child.json'), child + '\n');
    expect(f.cli(args).status).toBe(0);
    expect((readLockfile(out) as LockfileV2).build.id).not.toBe(first);
  });
}

test('output inventory canonicalizes relative, absolute and dot-segment aliases; sensitive wins in either order', () => {
  const f = fixture(); mkdirSync(f.out);
  writeFileSync(join(f.out, 'secret'), f.canary, { mode: 0o600 });
  writeFileSync(join(f.out, '.env'), f.canary, { mode: 0o600 });
  for (const publicPaths of [['secret', './secret', 'sub/../secret', join(f.out, 'secret')], [join(f.out, 'secret'), './secret']]) {
    expect(outputRecords(f.out, new Map([...publicPaths, './.env'].map(path => [path, sha256('public generated bytes')])), ['./secret'])).toEqual([
      { path: '.env', mode: 0o600 }, { path: 'secret', mode: 0o600 },
    ]);
  }
});

test('output inventory uses captured digests, never disk content; unavailable bytes are mode only', () => {
  const f = fixture(); mkdirSync(f.out);
  const generated = new Uint8Array([0, 255, 128, 10]);
  writeFileSync(join(f.out, 'public'), f.canary, { mode: 0o640 });
  writeFileSync(join(f.out, 'unavailable'), f.canary, { mode: 0o600 });
  expect(outputRecords(f.out, new Map([
    ['public', sha256(generated)], ['unavailable', undefined], ['missing', undefined],
  ]))).toEqual([
    { path: 'public', mode: 0o640, sha256: sha256(generated) },
    { path: 'unavailable', mode: 0o600 },
  ]);
});

test('build and run help describe optional pinning and Docker commit provenance', () => {
  const f = fixture();
  for (const command of ['build', 'run']) {
    const result = f.cli([command, '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/Requires?[^\n]*--pin-refs|--pin-refs\s+Required/i);
    expect(result.stdout).toMatch(/optional/i);
    expect(result.stdout).toMatch(/Docker records commits only when pinned/i);
  }
  expect(f.cli(['build', '--help']).stdout).toContain('cook build <recipe-path-or-url> [flags]');
});

test('identity changes for every git/npm pin, recipe, cook version, backend and option; canonical key order is stable', async () => {
  const f = fixture();
  expect(f.run('docker').status).toBe(0);
  const lock = f.lock();
  // Build a programmatic plan to exercise each identity input independently.
  const minimalFile = join(f.dir, 'minimal.json');
  writeFileSync(minimalFile, JSON.stringify({ name: 'minimal', agent: { systemPrompt: 'test' } }));
  const minimal = await resolvePlan(minimalFile, { noPrompts: true, strict: false });
  if (!minimal.ok) throw new Error('minimal plan failed');
  const record = (host = lock.connectomeHost, components = lock.components, options = {}) =>
    deploymentRecord(minimal.plan, 'docker', f.out, host, components, options).build.id;
  const id = record();
  expect(record({ ...lock.connectomeHost, commit: 'b'.repeat(40) })).not.toBe(id);
  for (const component of lock.components) {
    const changed = lock.components.map(c => c !== component ? c : c.kind === 'git'
      ? { ...c, commit: 'c'.repeat(40) } : { ...c, integrity: 'sha512-ZGVmZw==' });
    expect(record(lock.connectomeHost, changed)).not.toBe(id);
  }
  expect(record(lock.connectomeHost, lock.components.map(c => c.kind === 'npm' ? { ...c, version: '2.0.0' } : c))).not.toBe(id);
  expect(record(lock.connectomeHost, lock.components.map(c => c.kind === 'npm' ? { ...c, spec: '@scope/pkg@next', version: undefined } : c))).not.toBe(id);
  for (const options of [{ imageName: 'different' }, { strict: true }, { allowIncompleteTemplates: true }]) {
    expect(record(lock.connectomeHost, lock.components, options)).not.toBe(id);
  }
  minimal.plan.walks.push({ ...minimal.plan.parentWalk, path: '/child.json', sourceSha256: 'e'.repeat(64) });
  const withChild = record();
  minimal.plan.walks[1]!.sourceSha256 = 'f'.repeat(64);
  expect(record()).not.toBe(withChild);
  minimal.plan.parentWalk.sourceSha256 = 'd'.repeat(64);
  expect(record()).not.toBe(id);
  expect(buildId({ cook: '1', backend: 'host' })).not.toBe(buildId({ cook: '2', backend: 'host' }));
  expect(buildId({ cook: '1', backend: 'host' })).not.toBe(buildId({ cook: '1', backend: 'docker' }));
  expect(buildId({ a: 1, b: { z: 2, x: 3 } })).toBe(buildId({ b: { x: 3, z: 2 }, a: 1 }));
});

test('writer strips runtime value properties too; full-SHA enforcement and explicit output inventory', () => {
  const f = fixture(); expect(f.run('docker').status).toBe(0);
  const lock = f.lock();
  const wider = { name: 'answer', envName: 'ANSWER', origin: 'prompt', value: 'private-canary' };
  lock.requirements = [wider];
  writeLockfile(f.out, lock);
  expect(readFileSync(join(f.out, 'connectome.lock'), 'utf8')).not.toContain('private-canary');
  expect(() => writeLockfile(f.out, { ...lock, connectomeHost: { ...lock.connectomeHost, commit: 'abc' } })).toThrow(/full commit SHA/);
  for (const component of lock.components.filter(c => c.kind === 'git')) {
    expect(() => writeLockfile(f.out, { ...lock, components: [{ ...component, commit: 'abc' }] })).toThrow(/full commit SHA/);
  }
  const unpinned = { ...lock, connectomeHost: { ...lock.connectomeHost, commit: undefined },
    components: lock.components.map(c => c.kind === 'git' ? { ...c, commit: undefined } : c) };
  expect(() => writeLockfile(f.out, unpinned)).not.toThrow();
  expect(() => writeLockfile(f.out, { ...unpinned, backend: 'host' })).toThrow(/full commit SHA/);
  for (const value of ['', 'abc', 'g'.repeat(40), 'a'.repeat(39)]) expect(() => fullCommit(value, 'test')).toThrow();
  expect(fullCommit('A'.repeat(40), 'test')).toBe(SHA);
  expect(fullCommit('B'.repeat(64), 'test')).toBe('b'.repeat(64));
  writeFileSync(join(f.out, 'operator-state'), 'untracked');
  expect(outputRecords(f.out, new Map([['entrypoint.sh', undefined]])).map(o => o.path)).not.toContain('operator-state');
});

test('URL recipe provenance hashes the loaded text once, not a later fetch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cook-v2-url-')); dirs.push(dir);
  const text = '{ "name": "url", "agent": { "provider": "openai-codex", "systemPrompt": "test" } }\n';
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
    requests++;
    return new Response(text, { headers: { 'Content-Type': 'application/json' } });
  } });
  try {
    const url = `http://127.0.0.1:${server.port}/recipe.json`;
    const result = await resolvePlan(url, { noPrompts: true, strict: false });
    if (!result.ok) throw new Error('URL plan failed');
    expect((await runDockerBackend(result.plan, {
      outDir: dir, strict: false, noPrompts: true, pinRefs: true, pinnedChRef: SHA, allowIncompleteTemplates: false,
    })).exitCode).toBe(0);
    const lock = readLockfile(dir) as LockfileV2;
    expect(lock.recipe).toEqual({ path: url, sha256: sha256(text) });
    expect(requests).toBe(1);
  } finally { await server.stop(true); }
});

// Intentional fail-closed exit-code differences from main.
test('host missing HEAD refuses both initial install and reconcile with exit 3', () => {
  for (const reconcile of [false, true]) {
    const f = fixture();
    if (reconcile) expect(f.run('host').status).toBe(0);
    const before = existsSync(join(f.out, 'connectome.lock')) ? readFileSync(join(f.out, 'connectome.lock'), 'utf8') : null;
    expect(f.run('host', { TEST_MISSING_HEAD: '1' }, false).status).toBe(3);
    expect(existsSync(join(f.out, 'connectome.lock')) ? readFileSync(join(f.out, 'connectome.lock'), 'utf8') : null).toBe(before);
  }
});

test('host unreadable/unknown lock refuses reconcile with exit 2 and preserves the lock', () => {
  for (const raw of ['not JSON', '{"version":999}']) {
    const f = fixture(); mkdirSync(f.out);
    writeFileSync(join(f.out, 'connectome.lock'), raw);
    expect(f.run('host', {}, false).status).toBe(2);
    expect(readFileSync(join(f.out, 'connectome.lock'), 'utf8')).toBe(raw);
    expect(existsSync(join(f.out, 'app'))).toBe(false);
  }
});

test('output hasher covers embedded JSON, YAML, Docker env and shell escapes, without recording matches', () => {
  for (const answer of ["left'right", 'private-"\\\n\t-\'-$']) {
    for (const backend of ['host', 'docker'] as const) {
      const f = fixture();
      const recipe = JSON.parse(readFileSync(f.recipe, 'utf8'));
      recipe.services[0].environment = { LITERAL: answer };
      writeFileSync(f.recipe, JSON.stringify(recipe));
      expect(f.run(backend, { ODD_ANSWER: answer }).status).toBe(0);
      const forms = [answer, JSON.stringify(answer).slice(1, -1),
        readFileSync(join(f.out, '.env'), 'utf8'),
        readFileSync(join(f.out, backend === 'host' ? 'docker-compose.sidecars.yml' : 'docker-compose.yml'), 'utf8')];
      for (const form of forms) {
        expect(createOutputHasher([{ value: 'other' }, { value: answer }])(`prefix:${form}:suffix`))
          .toEqual({ sha256Omitted: 'contains-requirement-value' });
      }
    }
  }
  expect(createOutputHasher([{ value: '\ud800' }])('\ufffd'))
    .toEqual({ sha256Omitted: 'contains-requirement-value' });
  for (const value of ['a', 'ab', 'abc', '\n', '\\', '"']) {
    expect(createOutputHasher([{ value }])(`prefix:${value}:suffix`))
      .toEqual({ sha256Omitted: 'contains-requirement-value' });
  }
});

test('empty and unresolved requirements never match, and nonmatching outputs retain exact hashes', () => {
  const hash = createOutputHasher([{ value: '' }, {}, { value: 'private-answer' }]);
  expect(hash('')).toBe(sha256(''));
  expect(hash('ordinary output')).toBe(sha256('ordinary output'));
});
