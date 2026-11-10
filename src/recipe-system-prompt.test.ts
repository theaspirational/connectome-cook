import { expect, test } from 'bun:test';
import { validateRecipe } from './vendor/recipe.js';

const MESSAGE = 'Recipe agent must have a "systemPrompt" string';

test('absent or null systemPrompt is accepted and normalized to the empty string, as the host does', () => {
  expect(validateRecipe({ name: 'T', agent: {} }).agent.systemPrompt).toBe('');
  expect(validateRecipe({ name: 'T', agent: { systemPrompt: null } }).agent.systemPrompt).toBe('');
});

test('an empty systemPrompt is accepted unchanged', () => {
  expect(validateRecipe({ name: 'T', agent: { systemPrompt: '' } }).agent.systemPrompt).toBe('');
});

test('a non-string systemPrompt is still refused', () => {
  for (const systemPrompt of [42, true, ['x'], { text: 'x' }]) {
    expect(() => validateRecipe({ name: 'T', agent: { systemPrompt } })).toThrow(MESSAGE);
  }
});

test('a non-empty systemPrompt is kept as written', () => {
  expect(validateRecipe({ name: 'T', agent: { systemPrompt: 'Hello ${X}' } }).agent.systemPrompt).toBe('Hello ${X}');
});
