import type { Lockfile } from '../lockfile.js';
import { fail } from './schema.js';

export function validateLock(v: unknown): Lockfile {
  const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const text = (x: unknown) => typeof x === 'string' && !!x;
  if (!record(v) || v.version !== 1 || v.backend !== 'host' || !text(v.recipePath) || !text(v.createdAt) || !record(v.connectomeHost) || !text(v.connectomeHost.url) || !text(v.connectomeHost.ref) || !text(v.connectomeHost.path) || (v.connectomeHost.commit !== undefined && !text(v.connectomeHost.commit)) || !record(v.launch) || v.launch.kind !== 'script' || !text(v.launch.script)) fail('E_SCHEMA');
  if (!Array.isArray(v.components) || !v.components.every(c => record(c) && text(c.key) && ['mcp', 'extension'].includes(String(c.role)) && typeof c.url === 'string' && typeof c.ref === 'string' && text(c.path) && text(c.install) && (c.commit === undefined || text(c.commit)))) fail('E_SCHEMA');
  if (!Array.isArray(v.localExtensions) || !v.localExtensions.every(c => record(c) && text(c.name) && text(c.hostDir) && text(c.path))) fail('E_SCHEMA');
  if (!Array.isArray(v.requirements) || !v.requirements.every(c => record(c) && text(c.name) && text(c.envName) && text(c.origin) && (c.value === undefined || text(c.value)))) fail('E_SCHEMA');
  return v as unknown as Lockfile;
}
