/** Explicit extension/export boundary; no installation, history or service effects. */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Lockfile } from '../lockfile.js';
import { assertCredentialFreeSourceUrl } from '../source-url.js';
import { validateLock } from './lockfile.js';
import { CandidateError, canonical, fail, hash, parseJSON, validate, type Envelope, type Manifest } from './schema.js';

/** Declared code/config/bindings only, including an optional config revision. */
export function deploymentRevision(e: Envelope): string {
  if (!e.manifest) return fail('E_SCHEMA');
  const { revision: _revision, ...bindings } = e.manifest;
  return hash(canonical({ agent: e.agent, desired: e.desired, materialized: e.materialized, bindings }));
}

/** Adapt either envelope shape to the unchanged host materialization v1 reader.
 * Legacy records remain legacy; no missing deployment bindings are invented. */
export function materializationV1(value: unknown, lockBytes: string): Lockfile {
  const e = validate('connectome.deployment/v1', value);
  if (e.manifest && e.manifest.revision !== deploymentRevision(e)) fail('E_DIGEST');
  if (hash(lockBytes) !== e.materialized.lockDigest) fail('E_DIGEST');
  const lock = validateLock(parseJSON(lockBytes));
  if (e.manifest) {
    for (const source of [lock.connectomeHost, ...lock.components]) {
      if (!source.commit || !/^[0-9a-f]{40}$/.test(source.commit) || /^refs\/pull\//.test(source.ref)) fail('E_PIN_INCOMPLETE');
      try { assertCredentialFreeSourceUrl(source.url); } catch { fail('E_SCOPE'); }
    }
    // Every materialized code root, including local bundles, needs an artifact.
    for (const path of [lock.connectomeHost.path, ...lock.components.map(c => c.path), ...lock.localExtensions.map(c => c.path)]) {
      if (!path || !e.manifest.artifacts.some(a => {
        const role = e.manifest!.roles.find(r => r.name === a.role)!;
        return role.kind === 'runtime' && join(role.path, a.path) === path;
      })) fail('E_PROOF_INCOMPLETE');
    }
  }
  return lock;
}

/** Opt-in enrichment of an existing envelope with reviewed nonsecret metadata.
 * No config, credential or mutable-state bytes are read or hashed here. */
export function extendEnvelope(value: unknown, lockBytes: string, bindings: Omit<Manifest, 'revision'>): Envelope {
  const legacy = validate('connectome.deployment/v1', value);
  if (legacy.manifest) fail('E_SCHEMA');
  if (!bindings || Object.hasOwn(bindings, 'revision')) fail('E_SCHEMA');
  const e: Envelope = { ...legacy, manifest: { ...bindings, revision: '' } };
  e.manifest!.revision = deploymentRevision(e);
  validate('connectome.deployment/v1', e);
  materializationV1(e, lockBytes);
  return e;
}

export function exportManifest(value: unknown, lockBytes: string): string {
  const e = validate('connectome.deployment/v1', value);
  if (!e.manifest) fail('E_PROOF_INCOMPLETE');
  materializationV1(e, lockBytes);
  return canonical(e) + '\n';
}

export async function deploymentCommand(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write('cook deployment export ENVELOPE --lock LOCK [--bindings BINDINGS]\nRead-only, secret-free declared manifest export; not a backup or running attestation.\n');
    return 0;
  }
  try {
    if (![4, 6].includes(args.length) || args[0] !== 'export' || args[2] !== '--lock' || args[1]!.startsWith('-') || args[3]!.startsWith('-') || (args.length === 6 && (args[4] !== '--bindings' || args[5]!.startsWith('-')))) fail('E_USAGE', 1);
    let envelope = parseJSON(readFileSync(args[1]!, 'utf8'));
    const lockBytes = readFileSync(args[3]!, 'utf8');
    if (args.length === 6) envelope = extendEnvelope(envelope, lockBytes, parseJSON(readFileSync(args[5]!, 'utf8')) as Omit<Manifest, 'revision'>);
    const output = exportManifest(envelope, lockBytes);
    process.stdout.write(output);
    return 0;
  } catch (error) {
    // Never echo paths, invalid data or underlying filesystem error messages.
    process.stderr.write(`${error instanceof CandidateError ? error.code : 'E_IO'}: manifest export refused.\n`);
    return error instanceof CandidateError ? error.exitCode : 3;
  }
}
