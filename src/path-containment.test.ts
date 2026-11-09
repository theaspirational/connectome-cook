import { expect, test } from 'bun:test';
import { isPathWithin } from './path-containment.js';

test('lexical containment handles root, normalization, trailing separators and path-component boundaries', () => {
  for (const root of ['/', '/./', '//']) {
    expect(isPathWithin(root, '/')).toBe(true);
    expect(isPathWithin(root, '/private/state')).toBe(true);
    expect(isPathWithin(root, '/private/state/')).toBe(true);
    expect(isPathWithin('/private/state', root)).toBe(false);
  }
  for (const root of ['/private/state', '/private/state/', '/private/./state//']) {
    for (const path of ['/private/state', '/private/state/', '/private/state/./sessions', '/private/state/..safe']) {
      expect(isPathWithin(root, path)).toBe(true);
    }
    for (const path of ['/', '/private', '/private/state-sibling', '/private/state/../other']) {
      expect(isPathWithin(root, path)).toBe(false);
    }
  }
  expect(isPathWithin('settings/', 'settings/config.json')).toBe(true);
  expect(isPathWithin('settings', 'settings-sibling/config.json')).toBe(false);
});
