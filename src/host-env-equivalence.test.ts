import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cases, materialize } from './test-support/host-env-equivalence.js';

for (const scenario of cases) {
  test(`main CLI equivalence: .env bytes/mode, recipes and lock (${scenario})`, () => {
    const expected = JSON.parse(readFileSync(resolve(import.meta.dir,
      `../test/fixtures/host-env-main/${scenario}.json`), 'utf-8'));
    expect(materialize(resolve(import.meta.dir, '../bin/cook'), scenario)).toEqual(expected);
  });
}
