/** Opt-in engine inspection. Imported only when operator paths are supplied. */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { satisfies, valid, validRange } from 'semver';
import { repositoryIndependentGitEnv } from './git-env.js';
import { assertCredentialFreeSourceUrl } from './source-url.js';

export interface HostEngine { path: string; realPath: string; version: string }
export interface HostEngines { bun: HostEngine; node: HostEngine }

/** Only the cook-owned bin directory precedes the operator's search path. */
export function hostBuildPath(binDir: string, parentPath?: string): string {
  if (binDir.includes(':')) throw new Error('E_HOST_ENGINE_PATH: selected-engine install path must not contain ":" (build PATH separator)');
  return [binDir, ...(parentPath?.split(':') ?? [])].filter(Boolean).join(':');
}

export function checkEngine(path: string, range: unknown, engine = 'engine', cwd?: string): HostEngine {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) {
    throw new Error(`E_HOST_ENGINE_PATH: ${engine} requires an absolute executable path`);
  }
  let realPath: string;
  try { realPath = realpathSync(path); }
  catch { throw new Error(`E_HOST_ENGINE_PATH: ${engine} is not a readable executable file`); }
  let isFile: boolean;
  try { isFile = statSync(realPath).isFile(); }
  catch { throw new Error(`E_HOST_ENGINE_PATH: ${engine} is not a readable executable file`); }
  if (!isFile) throw new Error(`E_HOST_ENGINE_PATH: ${engine} path is not a file`);
  try { accessSync(path, constants.X_OK); }
  catch { throw new Error(`E_HOST_ENGINE_PATH: ${engine} file is not executable`); }
  if (typeof range !== 'string' || !range.trim() || !validRange(range)) {
    throw new Error(`E_HOST_ENGINE_REQUIREMENT: ${engine} requires a valid engines range`);
  }
  let output: string;
  try {
    // Preserve argv[0] for multi-call shims. Never echo subprocess output.
    output = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 10000, cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { throw new Error(`E_HOST_ENGINE_EXEC: ${engine} --version failed (execution, timeout or non-zero exit)`); }
  const version = valid(output);
  if (!version) throw new Error(`E_HOST_ENGINE_VERSION: ${engine} returned an invalid version`);
  if (!satisfies(version, range, { includePrerelease: true })) {
    // validRange canonicalizes the requirement; raw package text is not logged.
    throw new Error(`E_HOST_ENGINE_RANGE: ${engine} observed ${version}; required ${validRange(range)}`);
  }
  return { path, realPath, version };
}

export interface HostEnginePreflight {
  engines: HostEngines;
  commit: string;
  sourceDir: string;
  sourceUrl: string;
  cleanup: () => void;
  recheck: (cwd: string) => HostEngines;
}

/** Fetch once, inspect without builds, and retain that exact object store for
 * local materialization. Caller owns cleanup on every successful return.
 * onScratch lets the CLI register signal cleanup even before fetching. */
export function preflightHostEngines(url: string, ref: string, bunPath: string, nodePath: string, onScratch?: (cleanup: () => void) => void): HostEnginePreflight {
  assertCredentialFreeSourceUrl(url);
  // Git treats a colon before the first slash as a remote (including scp
  // host:path). Resolve only local spellings, as git clone does for origin.
  if (!isAbsolute(url) && !/^[^/]+:/.test(url)) url = process.cwd() + '/' + url;
  const env = repositoryIndependentGitEnv();
  const scratch = mkdtempSync(join(tmpdir(), 'cook-engines-'));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  onScratch?.(cleanup);
  const runGit = (args: string[]) => execFileSync('git', ['--git-dir=.', ...args], {
    cwd: scratch, env: { ...env, LC_ALL: 'C' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
  }).trim();
  const timedOut = (err: unknown) => {
    const failure = err as { signal?: string; code?: string };
    return !!failure.signal || failure.code === 'ETIMEDOUT';
  };
  const git = (args: string[], code: string, step: string) => {
    try { return runGit(args); }
    catch (err) {
      if (code === 'FETCH' && /mismatched algorithms|does not support.*hash algorithm/i.test(String((err as { stderr?: unknown }).stderr))) {
        throw new Error('E_HOST_ENGINE_OBJECT_FORMAT: SHA-256 host repositories are unsupported');
      }
      if (timedOut(err)) code = 'TIMEOUT';
      else if (code === 'FETCH' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(ref)) {
        // A failed fetch alone cannot distinguish a missing ref from transport
        // failure. Only ls-remote's documented exit 2 means no matching ref.
        try { runGit(['ls-remote', '--exit-code', '--', url, ref]); }
        catch (probeError) {
          if (timedOut(probeError)) code = 'TIMEOUT';
          else if ((probeError as { status?: number }).status === 2) code = 'REF';
        }
      }
      throw new Error(`E_HOST_ENGINE_${code}: git ${step} failed; no installation changed`);
    }
  };
  try {
    git(['init', '--bare', '--object-format=sha1', '.'], 'INIT', 'init');
    git(['fetch', '--depth=1', '--', url, ref], 'FETCH', 'fetch');
    const commit = git(['rev-parse', 'FETCH_HEAD^{commit}'], 'COMMIT', 'rev-parse FETCH_HEAD');
    const json = git(['show', commit + ':package.json'], 'PACKAGE', 'show package.json');
    let pkg: { engines?: { bun?: unknown; node?: unknown } } | null;
    try { pkg = JSON.parse(json); }
    catch { throw new Error('E_HOST_ENGINE_PACKAGE: invalid package.json'); }
    const engines = { bun: checkEngine(bunPath, pkg?.engines?.bun, 'bun'), node: checkEngine(nodePath, pkg?.engines?.node, 'node') };
    git(['update-ref', 'refs/heads/cook-selected', commit], 'COMMIT', 'update-ref cook-selected');
    const recheck = (cwd: string): HostEngines => {
      const observed = {
        bun: checkEngine(bunPath, pkg?.engines?.bun, 'bun', cwd),
        node: checkEngine(nodePath, pkg?.engines?.node, 'node', cwd),
      };
      for (const engine of ['bun', 'node'] as const) {
        if (observed[engine].version !== engines[engine].version) {
          throw new Error(`E_HOST_ENGINE_CHANGED: ${engine} observed ${observed[engine].version} in host; preflight ${engines[engine].version}`);
        }
      }
      return observed;
    };
    return { engines, commit, sourceDir: scratch, sourceUrl: url, cleanup, recheck };
  } catch (err) { cleanup(); throw err; }
}
