import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPlan, PlanInspectionError, resolvePlan, validatePlanWalks } from './plan.js';
import type { WalkResult } from './types.js';

const walk = (path: string): WalkResult => ({ path, recipe: {
  name: path, agent: { systemPrompt: 'Hello ${PLAN_TEST_VAR}' },
} });
const parent = () => walk('/recipes/parent.json');
const child = () => walk('/recipes/child.json');
const service = { name: 'db', image: 'db:1' };
const template = { hostPath: 'config.json', inContainer: '/config.json', template: '${TOKEN}' };

function failure(walks: WalkResult[], text: string) {
  for (const inspect of [validatePlanWalks, (w: WalkResult[]) => inspectPlan(w, true)]) {
    expect(() => inspect(walks)).toThrow(PlanInspectionError);
    expect(() => inspect(walks)).toThrow(text);
  }
}

describe('quiet plan inspection', () => {
  const stdout = spyOn(process.stdout, 'write');
  const stderr = spyOn(process.stderr, 'write');
  afterAll(() => { stdout.mockRestore(); stderr.mockRestore(); });
  afterEach(() => {
    expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
    stdout.mockClear(); stderr.mockClear();
  });

  test('empty walk is a typed structural failure', () => {
    failure([], 'walker returned no recipes — internal error');
  });
  test('all filename collisions precede child-only declarations', () => {
    const walks = [parent(), walk('/a/same.json'), walk('/b/same.json'),
      walk('/a/other.json'), walk('/b/other.json')];
    walks[1]!.recipe.services = [service];
    failure(walks, 'recipe filename collision');
    try { inspectPlan(walks, false); } catch (err) {
      expect((err as PlanInspectionError).messages).toHaveLength(2);
      expect((err as Error).message).not.toContain('declares services');
    }
  });
  test('child services rejected before child templates or detection', () => {
    const c = child();
    c.recipe.services = [service];
    c.recipe.containerTemplateFiles = [template];
    c.recipe.mcpServers = { unresolved: { command: 'node' } };
    failure([parent(), c], 'declares services (sidecars)');
  });
  test('child container templates rejected', () => {
    const c = child(); c.recipe.containerTemplateFiles = [template];
    failure([parent(), c], 'declares containerTemplateFiles');
  });
  test('parent declarations and empty child declarations are accepted', () => {
    const p = parent(); p.recipe.services = [service]; p.recipe.containerTemplateFiles = [template];
    const c = child(); c.recipe.services = []; c.recipe.containerTemplateFiles = [];
    expect(() => validatePlanWalks([p, c])).not.toThrow();
  });
  test('returns sources, git/local extensions and env without output or mutation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cook-inspection-'));
    try {
      writeFileSync(join(dir, 'entry.ts'), 'export {};');
      const p = walk(join(dir, 'root.json'));
      p.recipe.mcpServers = { tool: { command: 'node', source: { url: 'https://example.test/tool.git', install: 'npm' } } };
      p.recipe.extensions = {
        git: { kind: 'module', path: 'index.ts', source: { url: 'https://example.test/ext.git' } },
        local: { kind: 'module', path: './entry.ts' },
      };
      const before = structuredClone(p);
      const result = inspectPlan([p], true);
      expect(result.sources.map(s => s.url)).toEqual(['https://example.test/tool.git', 'https://example.test/ext.git']);
      expect(result.sources[1]?.role).toBe('extension');
      expect(result.localExtensions[0]?.hostDir).toBe(dir);
      expect(result.envVars.map(v => v.name)).toEqual(['PLAN_TEST_VAR']);
      expect(result.warnings).toEqual([]);
      expect(p).toEqual(before);
      expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('returns warnings from both detectors, including non-strict absolute extensions', () => {
    const p = parent(), c = child();
    p.recipe.mcpServers = { a: { source: { url: 'https://example.test/tool.git', install: 'npm' } } };
    c.recipe.mcpServers = { b: { source: { url: 'https://example.test/tool.git', install: 'pip-editable' } } };
    p.recipe.extensions = { ext: { kind: 'module', path: 'a.ts', source: { url: 'https://example.test/ext.git' } } };
    c.recipe.extensions = {
      ext: { kind: 'module', path: 'b.ts', source: { url: 'https://example.test/ext.git', ref: 'v2' } },
      external: { kind: 'module', path: '/external.ts' },
    };
    const result = inspectPlan([p, c], false);
    expect(result.warnings).toHaveLength(4);
    expect(result.warnings[0]).toContain('divergent install');
    expect(result.warnings[3]).toContain('must bind-mount');
    expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
  });
  test('strict detection failures are typed, quiet and preserve messages', () => {
    for (const kind of ['source', 'extension']) {
      const p = parent();
      if (kind === 'source') p.recipe.mcpServers = { unresolved: { command: 'node' } };
      else p.recipe.extensions = { external: { kind: 'module', path: '/external.ts' } };
      expect(() => inspectPlan([p], true)).toThrow(PlanInspectionError);
      expect(() => inspectPlan([p], true)).toThrow('strict mode');
    }
    expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
  });
});


test('resolvePlan passes the preloaded root through and still announces walking once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cook-plan-preloaded-'));
  const out = spyOn(process.stdout, 'write').mockReturnValue(true);
  const err = spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    const path = join(dir, 'nonexistent.json');
    const recipe = { name: 'preloaded', agent: { provider: 'openai-codex', systemPrompt: 'test' } };
    const result = await resolvePlan(path, { strict: true, noPrompts: true }, recipe);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.parentWalk.recipe).toBe(recipe);
    expect(out.mock.calls.map(c => c[0])).toEqual([
      `-> walking recipe ${path}\n`, 'OK loaded 1 recipe\n',
      '-> detecting MCP sources (strict)\n', 'OK detected 0 sources, 0 env vars\n',
    ]);
  } finally {
    out.mockRestore(); err.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
