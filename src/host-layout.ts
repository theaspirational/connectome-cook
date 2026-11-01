/** Explicit, opt-in standalone legacy layout. No data discovery or migration. */
import { dirname, join } from 'node:path';
import { privatePathParts } from './private-write.js';
import { provisionPrivateDirectory } from './private-directory.js';
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
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    const c = value as HostLayout;
    if (Object.keys(c).sort().join(',') !== [...roles, 'schema', 'connectorState'].sort().join(',') || c.schema !== 'connectome.host-layout/v1') throw 0;
    const paths: string[] = [];
    for (const role of roles) {
      const path = c[role];
      if (typeof path !== 'string' || !path.startsWith('/') || /[\0-\x1f\x7f]/.test(path)) throw 0;
      privatePathParts(path.slice(1));
      if (paths.some(p => p === path || p.startsWith(path + '/') || path.startsWith(p + '/'))) throw 0;
      paths.push(path);
    }
    if (c.runtime !== installDir) throw 0;
    if (!c.connectorState || typeof c.connectorState !== 'object' || Array.isArray(c.connectorState)) throw 0;
    for (const [consumer, env] of Object.entries(c.connectorState)) {
      if (!/^[A-Za-z0-9_-]+$/.test(consumer) || !env || typeof env !== 'object' || Array.isArray(env) || !Object.keys(env).length) throw 0;
      for (const [name, path] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof path !== 'string') throw 0;
        privatePathParts(path);
      }
    }
    // Validate existing roots before creating any root.
    for (const path of paths) provisionPrivateDirectory(path, false);
    return c;
  } catch { throw new Error('E_HOST_LAYOUT: invalid, overlapping or unsafe layout'); }
}
export function validateLayoutConsumers(layout: HostLayout, recipes: Recipe[]): void {
  for (const consumer of Object.keys(layout.connectorState)) {
    const matches = recipes.map(r => r.mcpServers?.[consumer]).filter(s => s !== undefined);
    if (!matches.length || matches.some(s => !s.command || s.url)) throw new Error('E_HOST_LAYOUT: state consumer must be declared stdio');
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
