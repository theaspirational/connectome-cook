import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderUserUnit, validateUserUnit } from './host-unit.js';

test('WorkingDirectory is bare with only percent escaped; ExecStart stays quoted', () => {
  const path = '/srv/example %h "quoted"\\root/$HOME';
  const unit = renderUserUnit(path);
  expect(unit.split('\n').find(line => line.startsWith('WorkingDirectory=')))
    .toBe('WorkingDirectory=' + path.replace(/%/g, '%%'));
  expect(unit).toContain('ExecStart=/bin/bash "/srv/example %%h \\"quoted\\"\\\\root/$$HOME/run.sh" --headless');
  expect(unit).not.toContain('Environment=');
});
test('unit renderer refuses relative, control and trailing-whitespace paths', () => {
  for (const path of ['relative', '/srv/a\nb', '/srv/a\0b', '/srv/a\tb', '/srv/a\rb', '/srv/a\x7fb', ' /srv/a', '/srv/a ', '/srv/a\u00a0']) {
    expect(() => renderUserUnit(path)).toThrow('E_HOST_UNIT');
  }
});
test('unit names have a 255-byte bound and reject paths/templates', () => {
  expect(() => validateUserUnit('a'.repeat(247) + '.service')).not.toThrow();
  for (const name of ['a'.repeat(248) + '.service', '../a.service', 'a.socket', 'a@b.service', '', 'a\n.service', 'a.service\n']) {
    expect(() => validateUserUnit(name)).toThrow('E_HOST_UNIT');
  }
});
test('user units do not order against system network targets', () => {
  const unit = renderUserUnit('/srv/example');
  expect(unit).not.toContain('After=network-online.target');
  expect(unit).not.toContain('EnvironmentFile=');
});

// Probe a known-good unit first: missing systemd/user-manager support is a
// reason to skip, but a failure parsing our generated unit must never be one.
function verify(unit: string, withUnrelatedWarning = false) {
  const dir = mkdtempSync(join(tmpdir(), 'cook-unit-parser-'));
  try {
    const file = join(dir, 'example.service');
    if (withUnrelatedWarning) {
      writeFileSync(join(dir, 'unrelated.service'), '[Service]\nExecStart=/bin/true\nUnknownCookFixtureKey=yes\n');
      unit = unit.replace('[Unit]\n', '[Unit]\nWants=unrelated.service\n');
    }
    writeFileSync(file, unit);
    return spawnSync('systemd-analyze', ['--user', 'verify', file], {
      encoding: 'utf8',
      env: { ...process.env, ...(withUnrelatedWarning ? { SYSTEMD_UNIT_PATH: dir + ':' } : {}) },
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const probe = verify('[Service]\nExecStart=/bin/true\n');
const skipReason = probe.error ? probe.error.message
  : probe.status !== 0 ? (probe.stderr.trim() || 'systemd user verification unavailable') : undefined;
if (skipReason) console.warn('SKIP systemd parser tests: ' + skipReason);
const parserTest = skipReason ? test.skip : test;
parserTest('systemd-analyze --user verify accepts generated special paths' + (skipReason ? ' (skip: ' + skipReason + ')' : ''), () => {
  for (const path of ['/srv/ordinary', '/srv/space path', '/srv/percent %h', '/srv/unicode λ雪', '/srv/example %h "quoted"\\root/$HOME']) {
    const result = verify(renderUserUnit(path));
    expect(result.stderr.split('\n').filter(line => line.includes('example.service:'))).toEqual([]);
    expect(result.status).toBe(0);
  }
});
parserTest('systemd rejects quoted WorkingDirectory (negative control)' + (skipReason ? ' (skip: ' + skipReason + ')' : ''), () => {
  const unit = renderUserUnit('/srv/example').replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory="/srv/example"');
  const result = verify(unit);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('WorkingDirectory= path is not absolute');
});

test('unit renderer refuses terminal backslashes, including even runs', () => {
  for (const count of [1, 2, 3]) {
    expect(() => renderUserUnit('/srv/end' + '\\'.repeat(count)))
      .toThrow('E_HOST_UNIT: installation path must not end in a backslash');
  }
});
parserTest('terminal backslash consumes ExecStart (negative control)', () => {
  const path = '/srv/end' + '\\';
  // Bypass validation only to demonstrate why this input must be refused.
  const unit = renderUserUnit('/srv/safe').replace('WorkingDirectory=/srv/safe', 'WorkingDirectory=' + path);
  const result = verify(unit);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Service has no ExecStart=');
  expect(() => renderUserUnit(path)).toThrow('E_HOST_UNIT');
});

test('restart rate limits bound repeated failures within five minutes', () => {
  const unitSection = renderUserUnit('/srv/example').split('[Service]')[0]!;
  expect(unitSection).toContain('StartLimitIntervalSec=300\n');
  expect(unitSection).toContain('StartLimitBurst=5\n');
});

test('unit renderer refuses colon-separated engine paths', () => {
  expect(() => renderUserUnit('/srv/a:b')).toThrow('E_HOST_ENGINE_PATH');
});

parserTest('systemd verification tolerates warnings naming unrelated units', () => {
  const result = verify(renderUserUnit('/srv/example'), true);
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('unrelated.service:');
  expect(result.stderr.split('\n').filter(line => line.includes('example.service:'))).toEqual([]);
});
