import { expect, test } from 'bun:test';
import { hostBuildPath } from './host-engines.js';

const bin = '/install/.cook-engines/bin';
test('selected engine build PATH has no current-directory entry with no parent PATH', () => {
  const previous = process.env.PATH;
  try {
    delete process.env.PATH;
    expect(process.env.PATH).toBeUndefined();
    expect(hostBuildPath(bin, process.env.PATH)).toBe('/install/.cook-engines/bin');
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
test('selected engine build PATH filters all empty inherited segments', () => {
  for (const parent of ['', ':', '::']) expect(hostBuildPath(bin, parent)).toBe('/install/.cook-engines/bin');
  expect(hostBuildPath(bin, ':/usr/bin::/bin:')).toBe('/install/.cook-engines/bin:/usr/bin:/bin');
});
