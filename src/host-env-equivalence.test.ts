import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cases, materialize, comparableLock } from './test-support/host-env-equivalence.js';

for (const scenario of cases) {
  test(`main CLI equivalence: .env bytes/mode, recipes and common lock fields (${scenario})`, () => {
    const expected = JSON.parse(readFileSync(resolve(import.meta.dir,
      `../test/fixtures/host-env-main/${scenario}.json`), 'utf-8'));
    const actual = materialize(resolve(import.meta.dir, '../bin/cook'), scenario);
    expect({ ...actual, lock: comparableLock(actual.lock) }).toEqual({ ...expected, lock: comparableLock(expected.lock) });
  });
}
