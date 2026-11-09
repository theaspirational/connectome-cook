import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Run in a clean process: no inherited credentials, probes, prompts or network.
// Snapshots were recorded on main 916cad09, before extracting inspection.
const root = resolve(import.meta.dir, '..');
const fixtures = ['triumvirate', 'triumvirate-mid'].flatMap(dir =>
  readdirSync(`${root}/examples/${dir}/recipes`).filter(f => f.endsWith('.json'))
    .map(f => `examples/${dir}/recipes/${f}`),
);
const scratch = '.cache/plan-characterization';
beforeAll(() => {
  const recipe = (extra = {}) => ({ name: 'characterization', agent: { provider: 'openai-codex', systemPrompt: 'test' }, ...extra });
  const write = (path: string, data: unknown) => {
    mkdirSync(resolve(root, scratch, path, '..'), { recursive: true });
    writeFileSync(resolve(root, scratch, path), JSON.stringify(data));
  };
  const service = { name: 'db', image: 'db:1' };
  const template = { hostPath: 'config.json', inContainer: '/config.json', template: '${TOKEN}' };
  write('a/same.json', recipe({ services: [service] }));
  write('b/same.json', recipe());
  write('a/other.json', recipe()); write('b/other.json', recipe());
  write('collisions.json', recipe({ modules: { fleet: { children: ['a/same.json', 'b/same.json', 'a/other.json', 'b/other.json'].map(recipe => ({ name: recipe, recipe })) } } }));
  for (const [name, extra] of Object.entries({ services: { services: [service], containerTemplateFiles: [template] }, templates: { containerTemplateFiles: [template] } })) {
    write(`${name}-child.json`, recipe(extra));
    write(`${name}.json`, recipe({ modules: { fleet: { children: [{ name: 'child', recipe: `${name}-child.json` }] } } }));
  }
  write('warnings.json', recipe({ extensions: {
    external: { kind: 'module', path: '/external.ts' },
    missing: { kind: 'module', path: './missing.ts' },
  } }));
});
afterAll(() => rmSync(resolve(root, scratch), { recursive: true, force: true }));
const cases = [...fixtures, 'missing-recipe.json', ...['collisions', 'services', 'templates', 'warnings'].map(f => `${scratch}/${f}.json`)];
for (const fixture of cases) {
  for (const mode of (fixture === fixtures[0] ? ['loose', 'strict', 'missing-env'] : ['loose', 'strict'])) {
    const strict = mode === 'strict';
    const envFile = mode === 'missing-env' ? 'missing-values.env' : undefined;
    test(`resolvePlan main characterization: ${fixture}, mode=${mode}`, () => {
      const script = `
        import { resolvePlan } from './src/plan.ts';
        import { createHash } from 'node:crypto';
        const events = [];
        process.stdout.write = s => { events.push(['stdout', String(s)]); return true; };
        process.stderr.write = s => { events.push(['stderr', String(s)]); return true; };
        const result = await resolvePlan(${JSON.stringify(fixture)}, {strict: ${strict}, noPrompts: true, envFile: ${JSON.stringify(envFile)}});
        console.log = () => {};
        await Bun.write(Bun.stdout, JSON.stringify({events, exitCode: result.ok ? 0 : result.exitCode, resultHash: createHash('sha256').update(JSON.stringify(result).replaceAll(process.cwd(), '<repo>')).digest('hex')}));
      `;
      const result = Bun.spawnSync([process.execPath, '-e', script], {
        cwd: root, env: { PATH: process.env.PATH!, HOME: '/nonexistent' },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe('');
      expect(result.stdout.toString().replaceAll(root, '<repo>')).toMatchSnapshot();
    });
  }
}
