/** Operator-selected host engines. Acquisition is temporary and never builds. */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { satisfies, valid, validRange } from 'semver';
import { gitEnvironment, processAllowlistEnv } from './process-env.js';
import { assertCredentialFreeSourceUrl } from './source-url.js';

export interface HostEngine { path: string; version: string }
export interface HostEngines { bun: HostEngine; node: HostEngine }
export function checkEngine(path: string, range: unknown): HostEngine {
  try {
    if (!isAbsolute(path) || /[\0\r\n]/.test(path) || typeof range !== 'string' || !range.trim() || !validRange(range)) throw 0;
    const absolute = realpathSync(path);
    if (!statSync(absolute).isFile()) throw 0;
    accessSync(absolute, constants.X_OK);
    const output = execFileSync(absolute, ['--version'], { encoding: 'utf8', timeout: 10000, env: processAllowlistEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const version = valid(output);
    if (!version || !satisfies(version, range)) throw 0;
    return { path: absolute, version };
  } catch { throw new Error('E_HOST_ENGINE: executable or host engine requirement refused'); }
}
/** Inspect the selected source, then bind materialization to that commit even
 * for a moving branch. Never create the install directory or execute builds. */
export function preflightHostEngines(url: string, ref: string, bunPath: string, nodePath: string): { engines: HostEngines; commit: string } {
  assertCredentialFreeSourceUrl(url);
  const scratch = mkdtempSync(join(tmpdir(), 'cook-engines-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: scratch, env: gitEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
  try {
    git(['init', '--bare', '.']);
    git(['fetch', '--depth=1', '--', url, ref]);
    const commit = git(['rev-parse', 'FETCH_HEAD^{commit}']);
    const pkg = JSON.parse(git(['show', commit + ':package.json'])) as { engines?: { bun?: unknown; node?: unknown } };
    return { engines: { bun: checkEngine(bunPath, pkg.engines?.bun), node: checkEngine(nodePath, pkg.engines?.node) }, commit };
  } catch { throw new Error('E_HOST_ENGINE: preflight refused; no installation materialized'); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}
