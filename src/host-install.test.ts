/**
 * Tests for the host backend's pure planning half (action list, path
 * rebasing, build commands, preview) plus requirements probing and the
 * lockfile round-trip. Execution (git clone / build commands) is exercised
 * only through the pure planner — never run in tests.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runHostBackend,
  hostBuildCommand,
  hostPathFor,
  isSatisfiedByLock,
  planHostActions,
  renderActionPreview,
  type CloneAction,
  type HostBackendOptions,
} from './backends/host.js';
import {
  collectRequirements,
  defaultEnvName,
  expandProbePath,
  firstProbeHit,
  enforceRequirements,
} from './requirements.js';
import { readLockfile, writeLockfile, type Lockfile } from './lockfile.js';
import type { InstallPlan } from './plan.js';
import type { McpSource, WalkResult } from './types.js';
import type { Recipe } from './vendor/recipe.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cook-host-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const OPTIONS: HostBackendOptions = {
  installDir: '/home/op/.connectome/installs/test',
  noPrompts: true,
  yes: true,
  chRepoUrl: 'https://github.com/anima-research/connectome-host.git',
  chRef: 'main',
  allowIncompleteTemplates: false,
};

function mcpSource(overrides: Partial<McpSource>): McpSource {
  return {
    key: 'https://github.com/x/zulip_mcp@main',
    url: 'https://github.com/x/zulip_mcp.git',
    ref: 'main',
    install: { kind: 'npm' },
    inContainerPath: '/zulip_mcp',
    refs: [{ recipePath: '/r.json', mcpServerName: 'zulip' }],
    ...overrides,
  };
}

function minimalPlan(overrides: Partial<InstallPlan>): InstallPlan {
  const walk: WalkResult = {
    path: '/r.json',
    recipe: { name: 'T', agent: { systemPrompt: 'x' } } as Recipe,
  };
  return {
    recipePath: '/r.json',
    walks: [walk],
    parentWalk: walk,
    sources: [],
    localExtensions: [],
    envVars: [],
    runtimeOnlyVars: [],
    credentialFiles: [],
    requirements: [],
    values: {},
    envFileValues: {},
    credentialValues: {},
    options: { strict: false, noPrompts: true },
    ...overrides,
  };
}

describe('hostPathFor', () => {
  test('rebases container paths onto the install dir', () => {
    expect(hostPathFor('/inst', '/zulip_mcp')).toBe('/inst/zulip_mcp');
    expect(hostPathFor('/inst', '/app/extensions/zk')).toBe('/inst/app/extensions/zk');
  });
});

describe('hostBuildCommand', () => {
  test('mirrors the docker runtimes', () => {
    expect(hostBuildCommand(mcpSource({ install: { kind: 'npm' } })))
      .toBe('npm install --no-audit --no-fund && npm run build');
    expect(hostBuildCommand(mcpSource({ install: { kind: 'pip-editable' } })))
      .toContain('python3 -m venv .venv');
    expect(hostBuildCommand(mcpSource({ install: { kind: 'custom', run: 'make x', runtime: 'custom' } })))
      .toBe('make x');
    expect(hostBuildCommand(mcpSource({ install: { kind: 'custom', run: '', runtime: 'bun' } })))
      .toBe('');
  });
});

describe('planHostActions', () => {
  test('always clones connectome-host first, then components', () => {
    const plan = minimalPlan({ sources: [mcpSource({})] });
    const actions = planHostActions(plan, OPTIONS);
    expect(actions.clones[0]!.role).toBe('connectome-host');
    expect(actions.clones[0]!.target).toBe(join(OPTIONS.installDir, 'app'));
    expect(actions.clones[0]!.buildCommand).toBe('bun install');
    expect(actions.clones[1]!.target).toBe(join(OPTIONS.installDir, 'zulip_mcp'));
  });

  test('skips npm-global with a reason; sibling-copy becomes a recipe-adjacent copy', () => {
    const plan = minimalPlan({
      sources: [
        mcpSource({ key: 'npm:pkg@1', url: '', install: { kind: 'npm-global', package: 'pkg@1' }, inContainerPath: '' }),
        mcpSource({
          key: 'sibling:x',
          url: '',
          install: { kind: 'sibling-copy', siblingDir: 'x' },
          inContainerPath: '/x',
          refs: [{ recipePath: '/home/op/proj/r.json', mcpServerName: 'x' }],
        }),
      ],
    });
    const actions = planHostActions(plan, OPTIONS);
    expect(actions.clones.length).toBe(1); // connectome-host only
    expect(actions.skipped.map((s) => s.key)).toEqual(['npm:pkg@1']);
    expect(actions.copies).toEqual([{
      key: 'sibling:x',
      from: '/home/op/proj/x',
      target: join(OPTIONS.installDir, 'x'),
    }]);
  });

  test('local extensions are used in place', () => {
    const plan = minimalPlan({
      localExtensions: [{
        name: 'zk',
        hostDir: '/home/op/exts/zk',
        entryBasename: 'index.ts',
        inContainerPath: '/app/extensions/zk',
        hasPackageJson: false,
        refs: [],
      }],
    });
    const actions = planHostActions(plan, OPTIONS);
    expect(actions.localExtensionPaths.get('zk')).toBe('/home/op/exts/zk/index.ts');
  });

  test('preview names every clone, build command, and skip', () => {
    const plan = minimalPlan({
      sources: [mcpSource({ authSecret: 'GIT_TOKEN' })],
    });
    const preview = renderActionPreview(planHostActions(plan, OPTIONS), OPTIONS);
    expect(preview).toContain('ON THIS MACHINE');
    expect(preview).toContain('https://github.com/x/zulip_mcp.git');
    expect(preview).toContain('npm install --no-audit --no-fund && npm run build');
    expect(preview).toContain('token from $GIT_TOKEN');
  });
});

describe('requirements', () => {
  test('defaultEnvName upper-snakes the key', () => {
    expect(defaultEnvName('spring-engine')).toBe('SPRING_ENGINE');
    expect(defaultEnvName('skirmish.ai lib')).toBe('SKIRMISH_AI_LIB');
  });

  test('expandProbePath handles ~, $VAR, and ${VAR}', () => {
    const env = { SPRING_HOME: '/opt/spring' };
    expect(expandProbePath('$SPRING_HOME/engine', env)).toBe('/opt/spring/engine');
    expect(expandProbePath('${SPRING_HOME}/engine', env)).toBe('/opt/spring/engine');
    expect(expandProbePath('~/x', env).endsWith('/x')).toBe(true);
    expect(expandProbePath('~/x', env).startsWith('/')).toBe(true);
    expect(expandProbePath('$UNSET/x', env)).toBe('/x');
  });

  test('firstProbeHit returns the first existing candidate', () => {
    const hit = join(dir, 'exists');
    mkdirSync(hit);
    expect(firstProbeHit(['/definitely/not/here', hit])).toBe(hit);
    expect(firstProbeHit(['/definitely/not/here'])).toBeUndefined();
    expect(firstProbeHit(undefined)).toBeUndefined();
  });

  test('collectRequirements merges declarations across recipes', () => {
    const mk = (path: string, probe: string[], required?: boolean): WalkResult => ({
      path,
      recipe: {
        name: 'T', agent: { systemPrompt: 'x' },
        requirements: { spring: { probe, ...(required !== undefined ? { required } : {}) } },
      } as Recipe,
    });
    const merged = collectRequirements([
      mk('/a.json', ['/opt/a'], false),
      mk('/b.json', ['/opt/b'], true),
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0]!.req.probe).toEqual(['/opt/a', '/opt/b']);
    expect(merged[0]!.req.required).toBe(true);
    expect(merged[0]!.declaredIn).toEqual(['/a.json', '/b.json']);
  });

  test('enforceRequirements throws only for unresolved required entries', () => {
    expect(() => enforceRequirements([
      { name: 'a', envName: 'A', required: false, origin: 'unresolved', declaredIn: [] },
    ])).not.toThrow();
    expect(() => enforceRequirements([
      { name: 'a', envName: 'A', required: true, origin: 'unresolved', declaredIn: ['/r.json'] },
    ])).toThrow(/Unresolved required requirement/);
  });
});

describe('lockfile', () => {
  test('round-trips and rejects unknown versions', () => {
    const lock: Lockfile = {
      version: 1,
      backend: 'host',
      recipePath: '/r.json',
      createdAt: '2026-07-20T00:00:00.000Z',
      connectomeHost: { url: 'https://x/ch.git', ref: 'main', commit: 'abc' },
      components: [{ key: 'k', role: 'mcp', url: 'u', ref: 'main', path: '/p', install: 'npm' }],
      localExtensions: [],
      requirements: [{ name: 'spring', envName: 'SPRING_HOME', value: '/opt/spring', origin: 'probe' }],
      launch: { kind: 'script', script: '/inst/run.sh' },
    };
    writeLockfile(dir, lock);
    expect(readLockfile(dir)).toEqual(lock);
    expect(readLockfile('/nonexistent-dir-xyz')).toBeNull();

    writeFileSync(join(dir, 'connectome.lock'), JSON.stringify({ version: 99 }));
    expect(() => readLockfile(dir)).toThrow(/unsupported lockfile version/);
  });
});

describe('isSatisfiedByLock', () => {
  const mkLock = (over: Partial<Lockfile> = {}): Lockfile => ({
    version: 1,
    backend: 'host',
    recipePath: '/r.json',
    createdAt: '2026-07-20T00:00:00.000Z',
    connectomeHost: { url: 'https://x/ch.git', ref: 'main', commit: 'oldsha' },
    components: [{
      key: 'https://x/y.git@main', role: 'mcp', url: 'https://x/y.git',
      ref: 'main', commit: 'oldsha', path: '/p', install: 'npm install',
    }],
    localExtensions: [],
    requirements: [],
    launch: { kind: 'script', script: '/inst/run.sh' },
    ...over,
  });
  const mkAction = (over: Partial<CloneAction> = {}): CloneAction => ({
    key: 'https://x/y.git@main', role: 'mcp', url: 'https://x/y.git',
    ref: 'main', target: dir, buildCommand: 'npm install', ...over,
  });

  test('satisfied on matching url+ref+install with no pin requested', () => {
    expect(isSatisfiedByLock(mkAction(), mkLock())).toBe(true);
  });

  test('a --pin-refs commit change forces a re-clone (component)', () => {
    expect(isSatisfiedByLock(mkAction({ commit: 'newsha' }), mkLock())).toBe(false);
    expect(isSatisfiedByLock(mkAction({ commit: 'oldsha' }), mkLock())).toBe(true);
    // Lock entry without a recorded commit never satisfies a pinned action.
    const unpinnedLock = mkLock();
    delete unpinnedLock.components[0]!.commit;
    expect(isSatisfiedByLock(mkAction({ commit: 'newsha' }), unpinnedLock)).toBe(false);
  });

  test('a --pin-refs commit change forces a re-clone (connectome-host)', () => {
    const ch = mkAction({
      key: 'connectome-host', role: 'connectome-host',
      url: 'https://x/ch.git', buildCommand: 'bun install',
    });
    expect(isSatisfiedByLock(ch, mkLock())).toBe(true);
    expect(isSatisfiedByLock({ ...ch, commit: 'newsha' }, mkLock())).toBe(false);
    expect(isSatisfiedByLock({ ...ch, commit: 'oldsha' }, mkLock())).toBe(true);
  });

  test('never satisfied when the target directory is gone', () => {
    expect(isSatisfiedByLock(mkAction({ target: '/nonexistent-dir-xyz' }), mkLock())).toBe(false);
  });
});

for (const kind of ['clone', 'copy', 'sidecar-template'] as const) for (const path of ['/.cook-engines', '/.cook-engines/bin/node']) test(`R3-3 ${kind} target ${path} is reserved before confirmation`, async () => {
  const plan = minimalPlan(kind === 'sidecar-template' ? {} : { sources: [mcpSource({
    inContainerPath: path,
    ...(kind === 'copy' ? { install: { kind: 'sibling-copy', siblingDir: 'fixture' } } : {}),
  })] });
  if (kind === 'sidecar-template') plan.parentWalk.recipe.services = [{
    name: 'fixture', image: 'fixture', templateFiles: [{ path: path.slice(1), template: 'hello-template' }],
  }];
  const installDir = join(dir, 'install');
  await expect(runHostBackend(plan, { ...OPTIONS, installDir, yes: false })).rejects.toThrow('E_HOST_ENGINE_RESERVED:');
  expect(existsSync(installDir)).toBe(false);
});
