/** Opt-in raw secret-file destinations, separate from generated deployment
 * config and program-refreshed credentials. Values never enter a declaration. */
import { readFileSync } from 'node:fs';
import { privatePathParts, privateWrite, type PrivateWriteOptions, type PrivateWriteResult } from './private-write.js';

export interface SecretFiles {
  schema: 'connectome.secret-files/v1';
  /** Absolute, dedicated, pre-provisioned 0700 directory. */
  root: string;
  /** Nonsecret names -> relative files exclusively owned by this declaration. */
  files: Record<string, string>;
}
export interface SecretSaveResult extends PrivateWriteResult {
  saved: true;
  adoptionRequired: 'restart-or-reload';
}
export class SecretSaveError extends Error {
  constructor() { super('E_SECRET_SAVE'); }
}
/** Validate even for API callers; never echo untrusted input on refusal. */
export function secretFiles(value: unknown): SecretFiles {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SecretSaveError();
    const c = value as SecretFiles;
    if (Object.keys(c).sort().join(',') !== 'files,root,schema' || c.schema !== 'connectome.secret-files/v1' || typeof c.root !== 'string' || !c.root.startsWith('/')) throw new SecretSaveError();
    privatePathParts(c.root.slice(1));
    if (!c.files || typeof c.files !== 'object' || Array.isArray(c.files) || !Object.keys(c.files).length) throw new SecretSaveError();
    const paths: string[] = [];
    for (const [name, path] of Object.entries(c.files)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new SecretSaveError();
      privatePathParts(path);
      if (paths.some(p => p === path || p.startsWith(`${path}/`) || path.startsWith(`${p}/`))) throw new SecretSaveError();
      paths.push(path);
    }
    return c;
  } catch { throw new SecretSaveError(); }
}

/** File only: no recipe loading, providers, fetches, builds or service calls.
 * Exact bytes, not a field merge. Empty/oversize values fail closed. */
export function saveSecret(config: SecretFiles, name: string, value: string | Uint8Array, options: PrivateWriteOptions = {}): SecretSaveResult {
  try {
    const c = secretFiles(config);
    if (!Object.hasOwn(c.files, name) || !(typeof value === 'string' || value instanceof Uint8Array)) throw new SecretSaveError();
    const size = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.byteLength;
    if (!size || size > 65536) throw new SecretSaveError();
    const result = privateWrite(c.root, c.files[name]!, value, options);
    return { saved: true, adoptionRequired: 'restart-or-reload', ...result };
  } catch { throw new SecretSaveError(); }
}

const USAGE = 'cook secret save --config <local-json> --name <destination> [--allow-tightening] < value\nSaves exact stdin bytes only; an explicit restart or reload is needed for adoption.\n';
/** Strict parsing: no value argv/env option and no remote config resolution. */
export async function secretCommand(argv: string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) { process.stdout.write(USAGE); return 0; }
  try {
    if (argv[0] !== 'save') throw new SecretSaveError();
    let configPath: string | undefined, name: string | undefined, allowTightening = false;
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--config' && !configPath) configPath = argv[++i];
      else if (arg === '--name' && !name) name = argv[++i];
      else if (arg === '--allow-tightening' && !allowTightening) allowTightening = true;
      else throw new SecretSaveError();
    }
    if (!configPath || !name || process.stdin.isTTY) throw new SecretSaveError();
    const config = secretFiles(JSON.parse(readFileSync(configPath, 'utf8')));
    // Bound input without reading an unbounded stdin into memory.
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 65536) throw new SecretSaveError();
      chunks.push(bytes);
    }
    const result = saveSecret(config, name, Buffer.concat(chunks), { allowTightening });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.durability === 'synced' ? 0 : 3;
  } catch { process.stderr.write('E_SECRET_SAVE: secret save refused.\n'); return 2; }
}
