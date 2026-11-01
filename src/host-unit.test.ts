import { expect, test } from 'bun:test';
import { renderUserUnit, validateUserUnit } from './host-unit.js';
test('unit paths quote spaces, backslashes, double quotes and specifiers', () => {
  const unit = renderUserUnit('/srv/example %h "quoted"\\root');
  expect(unit).toContain('%%h');
  expect(unit).toContain('\\"quoted\\"\\\\root');
  expect(unit).not.toContain('Environment=');
});
test('unit renderer refuses relative paths and control characters', () => {
  for (const path of ['relative', '/srv/a\nb', '/srv/a\0b', '/srv/a\tb']) expect(() => renderUserUnit(path)).toThrow('E_HOST_UNIT');
  for (const name of ['../a.service', 'a.socket', 'a@b.service']) expect(() => validateUserUnit(name)).toThrow('E_HOST_UNIT');
});

test('ExecStart escapes environment expansion separately from WorkingDirectory', () => {
  const unit = renderUserUnit('/srv/$HOME');
  expect(unit).toContain('WorkingDirectory="/srv/$HOME"');
  expect(unit).toContain('ExecStart=/bin/bash "/srv/$$HOME/run.sh" --headless');
});
