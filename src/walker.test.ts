import { describe, expect, test, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { walkRecipe } from './walker.js';

const examplesRoot = resolve(
  import.meta.dir,
  '..',
  'examples',
  'triumvirate',
  'recipes',
);

describe('walkRecipe', () => {
  test('walks the triumvirate parent + 4 fleet children in order', async () => {
    const parent = join(examplesRoot, 'triumvirate.json');
    const results = await walkRecipe(parent);

    expect(results).toHaveLength(5);  // parent + miner + reviewer + clerk + encyclopedist

    expect(results[0]?.path).toBe(parent);
    expect(results[0]?.recipe.name).toBe('Knowledge Mining Triumvirate');

    expect(results[1]?.path).toBe(join(examplesRoot, 'knowledge-miner.json'));
    expect(results[1]?.recipe.name).toBe(
      'Knowledge Miner (generic Triumvirate example)',
    );
    expect(results[2]?.path).toBe(join(examplesRoot, 'knowledge-reviewer.json'));
    expect(results[2]?.recipe.name).toBe('Knowledge Reviewer');
    expect(results[3]?.path).toBe(join(examplesRoot, 'clerk.json'));
    expect(results[3]?.recipe.name).toBe('Library Frontdesk');
    expect(results[4]?.path).toBe(join(examplesRoot, 'encyclopedist.json'));
    expect(results[4]?.recipe.name).toBe('Knowledge Encyclopedist');
  });

  test('walks a leaf recipe and returns a single entry', async () => {
    const leaf = join(examplesRoot, 'clerk.json');
    const results = await walkRecipe(leaf);

    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe(leaf);
    expect(results[0]?.recipe.name).toBe('Library Frontdesk');
  });

  describe('cycle handling', () => {
    let tmp: string;
    let aPath: string;
    let bPath: string;

    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), 'cook-walker-cycle-'));
      aPath = join(tmp, 'a.json');
      bPath = join(tmp, 'b.json');

      const stub = (name: string, childRecipe: string) => ({
        name,
        agent: { systemPrompt: 'stub' },
        modules: {
          fleet: {
            children: [
              { name: 'partner', recipe: childRecipe },
            ],
          },
        },
      });

      writeFileSync(aPath, JSON.stringify(stub('A', 'b.json')));
      writeFileSync(bPath, JSON.stringify(stub('B', 'a.json')));
    });

    afterAll(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    test('A → B → A produces exactly two entries with no infinite loop', async () => {
      const results = await walkRecipe(aPath);

      expect(results).toHaveLength(2);
      expect(results[0]?.path).toBe(aPath);
      expect(results[0]?.recipe.name).toBe('A');
      expect(results[1]?.path).toBe(bPath);
      expect(results[1]?.recipe.name).toBe('B');
    });
  });
});


for (const remote of [false, true]) test(`preloaded parent reuse is root-only for a ${remote ? 'remote' : 'local'} two-level fleet`, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cook-walker-reuse-'));
  const parentPath = remote ? 'https://example.invalid/fleet/parent.json' : join(tmp, 'parent.json');
  const childPath = remote ? 'https://example.invalid/fleet/child.json' : join(tmp, 'child.json');
  const parentObj = { name: 'Parent', agent: { systemPrompt: 'Parent only' },
    modules: { fleet: { children: [{ name: 'child', recipe: 'child.json' }] } },
  };
  const childObj = { name: 'Child', agent: { systemPrompt: 'Child only' } };
  const hits: string[] = [];
  // The parent is already loaded: only the remote child may be fetched.
  const fetcher = remote ? spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
    hits.push(String(input));
    if (String(input) !== childPath) throw Error('unexpected fetch');
    return new Response(JSON.stringify(childObj));
  }) as typeof fetch) : undefined;
  try {
    if (!remote) writeFileSync(childPath, JSON.stringify(childObj));
    // Parent deliberately absent from disk/transport: reuse must avoid rereading it.
    const walks = await walkRecipe(parentPath, parentObj);
    expect(walks).toHaveLength(2); expect(walks[0]?.recipe).toBe(parentObj);
    expect(walks[1]?.path).toBe(childPath); expect(walks[1]?.recipe).toEqual(childObj);
    if (remote) expect(hits).toEqual([childPath]);
  } finally { fetcher?.mockRestore(); rmSync(tmp, { recursive: true, force: true }); }
});
