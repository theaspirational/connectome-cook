import { expect, test } from 'bun:test';
import { hostBuildPath } from './host-engines.js';
import { processAllowlistEnv } from './process-env.js';

const engines = { bun: { path: '/opt/bun/bin/bun', version: '1.4.4' }, node: { path: '/opt/node/bin/node', version: '22.23.3' } };
test('selected engine build PATH has no current-directory entry with no parent PATH', () => {
  const previous = process.env.PATH;
  try {
    delete process.env.PATH;
    expect(processAllowlistEnv().PATH).toBeUndefined();
    expect(hostBuildPath(engines, processAllowlistEnv().PATH)).toBe('/opt/bun/bin:/opt/node/bin');
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
test('selected engine build PATH filters all empty inherited segments', () => {
  for (const parent of ['', ':', '::']) expect(hostBuildPath(engines, parent)).toBe('/opt/bun/bin:/opt/node/bin');
  expect(hostBuildPath(engines, ':/usr/bin::/bin:')).toBe('/opt/bun/bin:/opt/node/bin:/usr/bin:/bin');
});
