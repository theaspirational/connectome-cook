import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate, validateDeployment, validateStaged, parseJSON } from './candidate/schema.js';
import { materializationV1 } from './candidate/manifest.js';
const root = join(import.meta.dir, '../test/fixtures/deployment-v1');
const held = validate('connectome.deployment/v1', parseJSON(readFileSync(join(root, 'envelope.json'), 'utf8')));
const staged = { ...held, lifecycle: 'staged-candidate' as const, desired: { ...held.desired, declaration: '.cook/deploy-plan.json' as const } };
test('deployment readers distinguish staged and held, refusing cross acceptance and unknown lifecycles', () => {
  expect(validateDeployment(held)).toEqual(held);
  expect(validateStaged(JSON.parse(JSON.stringify(staged)))).toEqual(staged);
  expect(() => validate('connectome.deployment/v1', staged)).toThrow();
  expect(() => validateStaged(held)).toThrow();
  expect(() => validateDeployment({ ...staged, lifecycle: 'active' })).toThrow();
  expect(() => validateDeployment({ ...staged, desired: held.desired })).toThrow();
  expect(() => validateDeployment({ ...staged, unexpected: true })).toThrow();
});
test('staged materialization verifies the existing lock digest', () => {
  const bytes = readFileSync(join(root, 'connectome.lock'), 'utf8');
  expect(materializationV1(staged, bytes)).toEqual(materializationV1(held, bytes));
  expect(() => materializationV1(staged, bytes + ' ')).toThrow('E_DIGEST');
});
