/** Versioned deployment record. Never serialize resolved operator values here. */
import { createHash } from 'node:crypto';
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import type { InstallPlan } from './plan.js';
import type { McpSource } from './types.js';
import { deriveRequiredVars } from './prompts.js';
import { looksLikeSha } from './pin-refs.js';
import { shellQuote, escapeForEnvFile } from './env-encoding.js';
import { quoteForComposeEnvBlock } from './generators/compose.js';
import pkg from '../package.json' with { type: 'json' };

export const LOCKFILE_NAME = 'connectome.lock';

export interface LegacyComponent {
  kind?: 'git';
  key: string;
  role: 'mcp' | 'extension';
  url: string;
  ref: string;
  commit?: string;
  path: string;
  install: string;
}
export interface LockedGitComponent extends LegacyComponent {
  kind: 'git';
  // Docker records unresolved refs honestly; host materialization requires HEAD.
  commit?: string;
}
export interface LockedNpmComponent {
  kind: 'npm';
  key: string;
  role: 'mcp' | 'extension';
  name: string;
  spec: string;
  version?: string;
  integrity?: string;
  // Git-only fields: make callers narrow before using provenance.
  url?: never;
  ref?: never;
  commit?: never;
  path?: never;
  install?: never;
}
export type LockedComponent = LockedGitComponent | LockedNpmComponent;

/** v1 carried arbitrary answers here, including secrets. v2 is names only. */
export interface LockedRequirement {
  name: string;
  envName: string;
  origin: string;
}
interface LockCommon {
  /** A confirmed reinstall started but has not completed successfully. */
  incomplete?: true;
  /** Explicit roots and connector-state bindings for a split host install. */
  layout?: import('./host-layout.js').HostLayout;
  /** Operator-selected engines, validated against the acquired host. */
  engines?: import('./host-engines.js').HostEngines;
  /** Hash-pinned local inputs and explicit pre-install package.json edits. */
  hostDependencies?: import('./host-dependency.js').LockedHostDependency[];

  backend: 'docker' | 'host';
  recipePath: string;
  createdAt: string;
  localExtensions: Array<{ name: string; hostDir: string; path: string }>;
  launch: { kind: 'compose'; dir: string } | { kind: 'script'; script: string; userUnit?: string };
}
export interface LockfileV1 extends LockCommon {
  version: 1;
  connectomeHost: { url: string; ref: string; commit?: string; path?: string };
  components: LegacyComponent[];
  requirements: Array<LockedRequirement & { value?: string }>;
}
/** Engine/unit/layout/dependency extensions remain outside build identity. */
export interface LockfileV2 extends LockCommon {
  version: 2;
  cook: { version: string; commit?: string };
  recipe: { path: string; sha256: string };
  connectomeHost: { url: string; ref: string; commit?: string; path?: string };
  components: LockedComponent[];
  requirements: LockedRequirement[];
  build: { id: string; dir: string };
  credentials: string[];
  /** Only if cook defines a state location outside build.dir. */
  state?: { path: string };
  outputs: Array<{ path: string; mode: number; sha256?: string; sha256Omitted?: 'contains-requirement-value' }>;
}
export type Lockfile = LockfileV1 | LockfileV2;

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
/** Canonical JSON: lexically sorted object keys; array order is significant. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
  }
  return JSON.stringify(value);
}
export function buildId(inputs: unknown): string {
  return sha256(canonicalJson(inputs));
}
export function fullCommit(commit: string | undefined, location: string): string {
  if (!commit || !looksLikeSha(commit)) {
    throw new Error(`${location}: lock v2 requires a full commit SHA when recording a commit; no provenance can be guessed`);
  }
  return commit.toLowerCase();
}

/** Inventory only what the recipe declares. No new registry/cache lookup:
 * cook has no offline npm integrity metadata, so integrity is omitted. */
export function resolveNpmComponents(sources: McpSource[]): LockedNpmComponent[] {
  return sources.filter(s => s.install.kind === 'npm-global').map(source => {
    if (source.install.kind !== 'npm-global') throw new Error('unreachable');
    const spec = source.install.package;
    // The first @ in a scoped name is not the version delimiter. Preserve
    // tags/ranges (and any other spec main accepted) verbatim, never resolve.
    const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
    const name = at < 0 ? spec : spec.slice(0, at);
    const declaredVersion = at < 0 ? '' : spec.slice(at + 1);
    const version = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(declaredVersion);
    const exact = version && !version[1]?.split('.').some(part => /^0\d+$/.test(part));
    return { kind: 'npm', key: source.key, role: source.role ?? 'mcp', name, spec,
      ...(exact ? { version: declaredVersion } : {}) };
  });
}

/** Logical tree paths, never the machine's absolute recipe directory. URL
 * recipes use URL pathnames relative to the root URL's directory as well. */
function recipeIdentityPath(path: string, root: string): string {
  const url = /^https?:\/\//.test(path) ? new URL(path) : undefined;
  const rootUrl = /^https?:\/\//.test(root) ? new URL(root) : undefined;
  if (url) {
    return (rootUrl ? posix.relative(posix.dirname(rootUrl.pathname), url.pathname)
      : url.pathname.replace(/^\//, '')) + url.search;
  }
  if (rootUrl) return path.replace(/^[/\\]+/, '').split(sep).join('/');
  return relative(dirname(root), path).split(sep).join('/');
}

/** Names are a conservative superset: runtime vars have no secret marker.
 * RequiredVar already classifies build/sidecar secrets; LockedRequirement does
 * not. Reuse the existing collector rather than maintain a secret-name list. */
export function credentialNames(plan: InstallPlan): string[] {
  const sidecarSecrets = (plan.parentWalk.recipe.services ?? []).flatMap(s => s.secrets ?? []);
  const vars = deriveRequiredVars(plan.envVars, plan.sources, sidecarSecrets, plan.walks);
  return [...new Set([
    ...vars.map(v => v.name),
    ...vars.flatMap(v => v.altNames ?? []),
    ...plan.requirements.map(r => r.envName),
    ...plan.credentialFiles.flatMap(cf => cf.fields.map(f => f.envOverride ?? `${cf.path}#${f.name}`)),
  ])].sort();
}

export function deploymentRecord(
  plan: InstallPlan,
  backend: LockfileV2['backend'],
  dir: string,
  connectomeHost: LockfileV2['connectomeHost'],
  components: LockedComponent[],
  options: Record<string, unknown>,
): Pick<LockfileV2, 'cook' | 'recipe' | 'build' | 'credentials' | 'requirements'> {
  const cook = { version: pkg.version };
  // Programmatic plans without loader provenance hash canonical recipe JSON.
  const recipes = plan.walks.map(w => ({ path: recipeIdentityPath(w.path, plan.parentWalk.path), sha256: w.sourceSha256 ?? sha256(canonicalJson(w.recipe)) }));
  const recipe = { path: plan.recipePath, sha256: recipes[0]!.sha256 };
  const { path: _path, ...hostPin } = connectomeHost;
  const pins = components.map(c => c.kind === 'npm' ? c : {
    kind: c.kind, key: c.key, role: c.role, url: c.url, ref: c.ref, commit: c.commit, install: c.install,
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return {
    cook, recipe,
    build: { dir: resolve(dir), id: buildId({ recipe: recipe.sha256, recipes, pins: { connectomeHost: hostPin, components: pins }, cook, backend, options }) },
    credentials: credentialNames(plan),
    requirements: plan.requirements.map(({ name, envName, origin }) => ({ name, envName, origin })),
  };
}

/** Only the reason crosses into the lock, never the matching answer. */
export type PublicOutputDigest = string | { sha256Omitted: 'contains-requirement-value' } | undefined;

/** Snapshot EVERY resolved requirement, independent of origin/name/secrecy.
 * Match all non-empty answers, including one character: a minimum length
 * would leave short secrets verifiable. Empty/unresolved answers match nothing.
 * Include the encodings cook writes, without their surrounding quotes, so
 * embedded/prefixed answers are caught too. Reuse the writers' encoders. */
export function createOutputHasher(requirements: ReadonlyArray<{ value?: string }>): (content: string) => PublicOutputDigest {
  const forms = new Set<string>();
  for (const { value } of requirements) {
    if (value === undefined || value === '') continue;
    forms.add(value);
    forms.add(JSON.stringify(value).slice(1, -1)); // lowered JSON / JSON in YAML
    forms.add(quoteForComposeEnvBlock(value).slice(1, -1));
    const env = escapeForEnvFile(value);
    forms.add(env === value ? env : env.slice(1, -1));
    forms.add(shellQuote(value).slice(1, -1));
  }
  const encodedValues = [...forms].map(value => Buffer.from(value, 'utf8'));
  return content => {
    // Use the same UTF-8 bytes as writeFileSync, including surrogate replacement.
    const bytes = Buffer.from(content, 'utf8');
    // Deliberately check generated bytes BEFORE computing an output digest.
    if (encodedValues.some(value => bytes.includes(value))) {
      return { sha256Omitted: 'contains-requirement-value' };
    }
    return sha256(bytes);
  };
}

/** Explicit inventory, never a recursive scan of operator state. Public
 * digests must be captured from generated bytes BEFORE writing, not read back
 * from the filesystem. Undefined digests mean mode only. Disk supplies modes
 * only: symlinks, hardlinks and concurrent changes cannot supply hash inputs.
 * Sensitive paths (env, credentials, rendered templates) always get mode only,
 * even when also declared public under another spelling of the same path. */
export function outputRecords(
  dir: string,
  publicOutputs: ReadonlyMap<string, PublicOutputDigest>,
  sensitivePaths: string[] = [],
): LockfileV2['outputs'] {
  const root = resolve(dir);
  const normalize = (path: string) => relative(root, resolve(root, path));
  const sensitive = new Set(['.env', ...sensitivePaths].map(normalize));
  const digests = new Map([...publicOutputs].map(([path, digest]) => [normalize(path), digest]));
  const records: LockfileV2['outputs'] = [];
  for (const path of [...new Set([...digests.keys(), ...sensitive])].sort()) {
    let mode: number;
    try { mode = statSync(resolve(root, path)).mode & 0o777; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      continue; // A declared but unwritten output is not recorded.
    }
    const digest = sensitive.has(path) ? undefined : digests.get(path);
    records.push({ path, mode, ...(typeof digest === 'string' ? { sha256: digest } : digest ?? {}) });
  }
  return records;
}

export function serializeLockfile(lock: Lockfile): string {
  if (lock.version === 2 && (lock.backend === 'host' || lock.connectomeHost.commit !== undefined)) {
    fullCommit(lock.connectomeHost.commit, 'connectome-host');
  }
  for (const c of lock.components) if (lock.version === 2 && c.kind === 'git' && (lock.backend === 'host' || c.commit !== undefined)) {
    fullCommit(c.commit, c.key);
  }
  // Defense in depth against callers passing a wider runtime requirement.
  const safe = { ...lock, requirements: lock.requirements.map(({ name, envName, origin }) => ({ name, envName, origin })) };
  return JSON.stringify(safe, null, 2) + '\n';
}

export function writeLockfile(dir: string, lock: LockfileV2): void {
  writeFileSync(join(dir, LOCKFILE_NAME), serializeLockfile(lock));
}

export function readLockfile(dir: string): Lockfile | null {
  const path = join(dir, LOCKFILE_NAME);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as { version: unknown };
  if (raw.version !== 1 && raw.version !== 2) {
    throw new Error(`${path}: unsupported lockfile version ${String(raw.version)}`);
  }
  return raw as Lockfile;
}
