/** Cross-PR contracts: #11's environment boundary on #6/#10 subprocess paths. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEngine } from './host-engines.js';
import { repositoryIndependentGitEnv } from './git-env.js';
import { PinnedCommands } from './pinned-commands.js';

test('engine probes and cancellable builds use parent-only opt-in; acquisition can exclude it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cook-merge-env-'));
  const name = 'COOK_MERGE_SYNTHETIC_VALUE';
  const previous = { value: process.env[name], selected: process.env.COOK_PASS_ENV };
  try {
    process.env[name] = 'synthetic-parent';
    const engine = join(dir, 'engine');
    writeFileSync(engine, `#!${process.execPath}\nconsole.log(process.env.${name} ? '2.0.0' : '1.0.0');\n`, { mode: 0o755 });
    for (const selected of [false, true]) {
      if (selected) process.env.COOK_PASS_ENV = name;
      else delete process.env.COOK_PASS_ENV;
      expect(checkEngine(engine, '*').version).toBe(selected ? '2.0.0' : '1.0.0');
      const output = await new PinnedCommands().run(process.execPath,
        ['-e', `console.log(process.env.${name} ?? 'absent')`], dir);
      expect(output).toBe(selected ? 'synthetic-parent' : 'absent');
      expect(repositoryIndependentGitEnv([name])[name]).toBeUndefined();
    }
  } finally {
    if (previous.value === undefined) delete process.env[name]; else process.env[name] = previous.value;
    if (previous.selected === undefined) delete process.env.COOK_PASS_ENV; else process.env.COOK_PASS_ENV = previous.selected;
    rmSync(dir, { recursive: true, force: true });
  }
});
