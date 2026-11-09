/** Static user-unit export only. No systemd or service side effects. */
import { isAbsolute, join } from 'node:path';
import { assertHostEnginePath } from './host-engine-path.js';

export function validateUserUnit(name: string): void {
  if (typeof name !== 'string' || Buffer.byteLength(name, 'utf8') > 255
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.service$/.test(name)) {
    throw new Error('E_HOST_UNIT: invalid user unit name (max 255 bytes)');
  }
}
function unitQuote(value: string, exec = false): string {
  if (!isAbsolute(value) || /[\0-\x1f\x7f]/.test(value)) throw new Error('E_HOST_UNIT: absolute control-free paths required');
  if (exec) value = value.replace(/\$/g, '$$$$');
  // Unit specifiers expand even in quoted strings.
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
}
export function renderUserUnit(installDir: string, name = 'connectome.service', workingDirectory = installDir): string {
  assertHostEnginePath(installDir);
  validateUserUnit(name);
  // A terminal backslash can continue this bare value onto ExecStart.
  // Refuse all terminal runs rather than attempting another representation.
  if (workingDirectory.endsWith('\\')) {
    throw new Error('E_HOST_UNIT: installation path must not end in a backslash');
  }
  if (!isAbsolute(workingDirectory) || /[\0-\x1f\x7f]/.test(workingDirectory) || /\s$/.test(workingDirectory)) {
    throw new Error('E_HOST_UNIT: absolute control-free path without trailing whitespace required');
  }
  return [
    '[Unit]',
    'Description=Connectome host (' + name + ')',
    'StartLimitIntervalSec=300',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    // WorkingDirectory is not an Exec* command: quotes are literal.
    'WorkingDirectory=' + workingDirectory.replace(/%/g, '%%'),
    'ExecStart=/bin/bash ' + unitQuote(join(installDir, 'run.sh'), true) + ' --headless',
    'Restart=on-failure',
    'RestartSec=5s',
    'UMask=0077',
    'StandardOutput=journal',
    'StandardError=journal',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
