/** Explicit, opt-in standalone legacy layout. No data discovery or migration. */
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { privatePathParts, provisionPrivateDirectory } from './private-directory.js';
import { isPathWithin } from './path-containment.js';
import type { Recipe } from './vendor/recipe.js';

export interface HostLayout {
  schema: 'connectome.host-layout/v1';
  config: string;
  runtime: string;
  state: string;
  workspace: string;
  credentials: string;
  /** Named stdio consumer -> env name -> state-root-relative file. */
  connectorState: Record<string, Record<string, string>>;
}
const roles = ['config', 'runtime', 'state', 'workspace', 'credentials'] as const;
export function hostLayout(value: unknown, installDir: string): HostLayout {
  const fail = (property: string, reason: string): never => { throw new Error(`E_HOST_LAYOUT: ${property}: ${reason}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('layout', 'expected an object');
  const c = value as HostLayout;
  if (Object.keys(c).sort().join(',') !== [...roles, 'schema', 'connectorState'].sort().join(',') || c.schema !== 'connectome.host-layout/v1') fail('schema/keys', 'expected connectome.host-layout/v1 and exactly the declared properties');
  const paths: Array<{ role: string; path: string }> = [];
  for (const role of roles) {
    const path = c[role];
    if (typeof path !== 'string' || !path.startsWith('/') || /[\0-\x1f\x7f]/.test(path)) fail(role, `expected an absolute control-free path: ${JSON.stringify(path)}`);
    try { privatePathParts(path.slice(1)); }
    catch { fail(role, `${path}: noncanonical path (empty, dot or traversal component)`); }
    const overlap = paths.find(p => isPathWithin(path, p.path) || isPathWithin(p.path, path));
    if (overlap) fail(role, `${path}: overlaps ${overlap.role} ${overlap.path}`);
    paths.push({ role, path });
  }
  if (c.runtime !== installDir) fail('runtime', `${c.runtime}: must equal --out ${installDir}`);
  if (!c.connectorState || typeof c.connectorState !== 'object' || Array.isArray(c.connectorState)) fail('connectorState', 'expected an object');
  for (const [consumer, env] of Object.entries(c.connectorState)) {
    if (!/^[A-Za-z0-9_-]+$/.test(consumer) || !env || typeof env !== 'object' || Array.isArray(env) || !Object.keys(env).length) fail(`connectorState.${consumer}`, 'expected a named consumer and nonempty env mapping');
    const files = Object.values(env);
    if (files.some(file => typeof file === 'string' && files.some(other => typeof other === 'string' && other !== file && isPathWithin(file, other)))) fail(`connectorState.${consumer}`, 'a file cannot also be a parent directory');
    for (const [name, path] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof path !== 'string') fail(`connectorState.${consumer}.${name}`, 'expected an env name and relative file path');
      try { privatePathParts(path); }
      catch { fail(`connectorState.${consumer}.${name}`, `${path}: unsafe relative path`); }
    }
  }
  // Check all existing roots before creating any. Retain both role and cause.
  const identities = new Set<string>();
  for (const { role, path } of paths) {
    let stat;
    try { stat = provisionPrivateDirectory(path, false); }
    catch (err) { fail(role, `${path}: ${err instanceof Error ? err.message : String(err)}`); }
    if (stat) {
      const identity = `${stat.dev}:${stat.ino}`;
      if (identities.has(identity)) fail(role, `${path}: root aliases another root (device/inode)`);
      identities.add(identity);
    }
  }
  return c;
}

export function validateLayoutConsumers(layout: HostLayout, recipes: Recipe[]): void {
  for (const consumer of Object.keys(layout.connectorState)) {
    const matches = recipes.map(r => r.mcpServers?.[consumer]).filter(s => s !== undefined);
    if (!matches.length || matches.some(s => !s.command || s.url)) throw new Error(`E_HOST_LAYOUT: state consumer ${consumer} must be declared stdio`);
  }
}
export function provisionLayout(layout: HostLayout): void {
  for (const role of roles) provisionPrivateDirectory(layout[role]);
  provisionPrivateDirectory(join(layout.config, 'recipes'));
  for (const [consumer, env] of Object.entries(layout.connectorState)) {
    const root = join(layout.state, 'connectors', consumer);
    provisionPrivateDirectory(join(layout.state, 'connectors'));
    provisionPrivateDirectory(root);
    for (const path of Object.values(env)) {
      let current = root;
      for (const part of dirname(path).split('/').filter(p => p !== '.')) {
        current = join(current, part); provisionPrivateDirectory(current);
      }
    }
  }
}
export function applyConnectorState(configuration: Recipe, layout: HostLayout): void {
  for (const [consumer, mapping] of Object.entries(layout.connectorState)) {
    const server = configuration.mcpServers?.[consumer];
    if (!server) continue;
    server.env = { ...server.env };
    for (const [name, path] of Object.entries(mapping)) server.env[name] = join(layout.state, 'connectors', consumer, path);
  }
}

/** Only paths move: preserve mount names, permissions and all other options. */
export function applyWorkspaceMounts(configuration: Recipe, layout: HostLayout): void {
  const workspace = configuration.modules?.workspace;
  if (workspace === false) return;
  if (workspace === null || (typeof workspace === 'object' && !Array.isArray(workspace.mounts))) {
    throw new Error('E_HOST_LAYOUT: modules.workspace requires a mounts array');
  }
  const mounts = typeof workspace === 'object' ? workspace.mounts : [
    { name: 'input', path: './input', mode: 'read-only' as const },
    { name: 'products', path: './output', mode: 'read-write' as const },
  ];
  const reserved = [layout.state, layout.config, layout.runtime, layout.credentials];
  const lowered = mounts.map(mount => {
    if (/\$\{[^}]*\}/.test(mount.path)) {
      throw new Error(`E_HOST_LAYOUT: workspace mount ${mount.name}: variable path is unsupported: ${mount.path}`);
    }
    const path = isAbsolute(mount.path) ? resolve(mount.path) : resolve(layout.workspace, mount.path);
    // Also reject ancestors exposing a reserved root (e.g. '..' or '/').
    if (reserved.some(root => isPathWithin(root, path) || isPathWithin(path, root))) {
      throw new Error('E_HOST_LAYOUT: workspace mount exposes a reserved root: ' + mount.path);
    }
    return { ...mount, path };
  });
  configuration.modules = { ...configuration.modules, workspace: {
    ...(typeof workspace === 'object' ? workspace : {}), mounts: lowered,
  } };
}

/** Reject CWD-dependent executable paths after overlays have been applied. */
export function validateLayoutStdio(configuration: Recipe): void {
  for (const [name, server] of Object.entries(configuration.mcpServers ?? {})) {
    if (!server.command || server.url) continue;
    for (const value of [server.command, ...(server.args ?? [])]) {
      if (value.startsWith('./') || value.startsWith('../')) {
        throw new Error(`E_HOST_LAYOUT: stdio server ${name}: CWD-relative executable/arg ${JSON.stringify(value)}`);
      }
    }
  }
}
