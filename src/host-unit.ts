/** Static user-unit export only. No systemd or service side effects. */
import { isAbsolute, join } from 'node:path';

export function validateUserUnit(name: string): void {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.service$/.test(name)) throw new Error('E_HOST_UNIT: invalid user unit name');
}
function unitQuote(value: string, exec = false): string {
  if (!isAbsolute(value) || /[\0-\x1f\x7f]/.test(value)) throw new Error('E_HOST_UNIT: absolute control-free paths required');
  if (exec) value = value.replace(/\$/g, '$$$$');
  // Unit specifiers expand even in quoted strings.
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
}
export function renderUserUnit(installDir: string): string {
  return [
    '[Unit]',
    'Description=Connectome host',
    '',
    '[Service]',
    'Type=simple',
    'WorkingDirectory=' + unitQuote(installDir),
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
