import { materializationV1 } from './manifest.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { canonical, fail, hash, validate, type Envelope, type Declaration, type Hold, type Intent, type Result, type Marker } from './schema.js';
import { fresh, operationLock, publish, readPrivate, readRecord, privateDir } from './io.js';

export interface Binding { envelope: Envelope; declaration: Declaration; hold: Hold }
export function bindings(root: string): Binding {
  const envelope = readRecord(root, 'connectome.deployment.json', 'connectome.deployment/v1');
  const declaration = readRecord(root, '.cook/declaration.json', 'connectome.declaration/v1');
  const hold = readRecord(root, '.cook/hold.json', 'connectome.hold/v1');
  if (canonical(envelope.agent) !== canonical(declaration.agent) || canonical(envelope.agent) !== canonical(hold.agent)) fail('E_IDENTITY');
  if (hash(canonical(declaration)) !== envelope.desired.configDigest || hash(readPrivate(join(root, 'connectome.lock'))) !== envelope.materialized.lockDigest) fail('E_DIGEST');
  const lock = materializationV1(envelope, readPrivate(join(root, 'connectome.lock')));
  if (lock.launch.kind !== 'script' || lock.launch.script !== join(root, 'run.sh') || lock.connectomeHost.path !== join(root, 'app')) fail('E_PATH');
  privateDir(join(root, 'data'));
  return { envelope, declaration, hold };
}
export function matchIntent(binding: Binding, intent: Intent): void {
  if (canonical(intent.agent) !== canonical(binding.envelope.agent)) fail('E_IDENTITY');
  if (intent.configDigest !== binding.envelope.desired.configDigest || intent.lockDigest !== binding.envelope.materialized.lockDigest) fail('E_DIGEST');
}
export function matchResult(intent: Intent, result: Result): void {
  for (const key of Object.keys(intent) as Array<keyof Intent>) {
    if (key !== 'schema' && canonical(intent[key]) !== canonical(result[key])) fail(key === 'agent' ? 'E_IDENTITY' : 'E_DIGEST');
  }
}
export function markerFor(result: Result): Marker {
  const { schema: _schema, dataDir: _data, startedAt: _start, finishedAt, ...shared } = result;
  return validate('connectome.seed-consumed/v1', { ...shared, schema: 'connectome.seed-consumed/v1', consumedAt: finishedAt, ingestResultDigest: hash(canonical(result)) });
}
/** Forward adapter boundary. Production has NO registered adapter. Synthetic
 * implementations are supplied by tests, never selected by flags, files or env.
 * Revalidation must inspect durable history and actual store identity, not just
 * saved JSON. It is read-only and must honor abort; ingest must leave no detached
 * writers, even on failure. Producer semantics require PR08 ratification. */
export interface QualifiedAdapter {
  id: string;
  revalidate(root: string, result: Readonly<Result>, signal: AbortSignal): Promise<boolean>;
}
export type Adapters = ReadonlyMap<string, QualifiedAdapter>;
const productionAdapters: Adapters = new Map();
async function revalidate(root: string, result: Result, adapters: Adapters, timeoutMs: number): Promise<void> {
  const adapter = adapters.get(result.adapterId);
  if (!adapter || adapter.id !== result.adapterId) fail('E_INGEST_UNQUALIFIED', 4);
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ok = await Promise.race([
      Promise.resolve().then(() => adapter.revalidate(root, structuredClone(result), controller.signal)),
      new Promise<false>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, Math.min(timeoutMs, 30_000)); }),
    ]);
    if (!ok || controller.signal.aborted) fail('E_INGEST_INCOMPLETE');
  } catch { fail('E_INGEST_INCOMPLETE'); }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}
export async function complete(root: string, adapters: Adapters = productionAdapters, timeoutMs = 30_000): Promise<Marker> {
  const release = operationLock(root);
  try {
    const initial = bindings(root);
    const intent = readRecord(root, '.cook/ingest.intent.json', 'connectome.ingest-intent/v1');
    const result = readRecord(root, '.cook/ingest.result.json', 'connectome.ingest-result/v1');
    matchIntent(initial, intent); matchResult(intent, result);
    await revalidate(root, result, adapters, timeoutMs);
    // Nothing read before adapter execution is trusted without rechecking.
    if (canonical(bindings(root)) !== canonical(initial) || canonical(readRecord(root, '.cook/ingest.intent.json', 'connectome.ingest-intent/v1')) !== canonical(intent) || canonical(readRecord(root, '.cook/ingest.result.json', 'connectome.ingest-result/v1')) !== canonical(result)) fail('E_DIGEST');
    const marker = markerFor(result);
    publish(join(root, 'data/seed.consumed'), canonical(marker), { identical: true });
    return marker;
  } finally { release(); }
}
/** Test-only admission seam, NOT a production ingest runner/registry. The CLI
 * imports only complete(), whose default registry is permanently empty here. */
export async function syntheticIngest(root: string, input: Pick<Intent, 'seedDigest' | 'toolDigest' | 'namespace' | 'adapterId'>, adapter: QualifiedAdapter & { ingest(root: string, intent: Intent): Promise<Result> }, afterResult?: () => void): Promise<Marker> {
  const release = operationLock(root);
  try {
    fresh(root);
    const initial = bindings(root);
    const intent = validate('connectome.ingest-intent/v1', { ...input, schema: 'connectome.ingest-intent/v1', operationId: randomUUID(), agent: initial.envelope.agent, configDigest: initial.envelope.desired.configDigest, lockDigest: initial.envelope.materialized.lockDigest, dataDir: 'data', startedAt: new Date().toISOString() });
    if (adapter.id !== intent.adapterId) fail('E_INGEST_UNQUALIFIED', 4);
    publish(join(root, '.cook/ingest.intent.json'), canonical(intent));
    const result = validate('connectome.ingest-result/v1', await adapter.ingest(root, structuredClone(intent)));
    matchResult(intent, result);
    await revalidate(root, result, new Map([[adapter.id, adapter]]), 30_000);
    if (canonical(bindings(root)) !== canonical(initial) || canonical(readRecord(root, '.cook/ingest.intent.json', 'connectome.ingest-intent/v1')) !== canonical(intent)) fail('E_DIGEST');
    publish(join(root, '.cook/ingest.result.json'), canonical(result));
    afterResult?.();
    const marker = markerFor(result);
    publish(join(root, 'data/seed.consumed'), canonical(marker));
    return marker;
  } finally { release(); }
}
export function inspectSeed(root: string, binding: Binding, adapters: Adapters = productionAdapters): string {
  const entries = readdirSync(join(root, 'data'));
  // The verifier must not confuse pristine seedRequired=false with proof.
  if (!binding.declaration.seedRequired && entries.length === 0) {
    try { readPrivate(join(root, '.cook/ingest.intent.json')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'I_NOT_APPLICABLE'; throw e; }
  }
  let intent: Intent, result: Result, marker: Marker;
  try {
    intent = readRecord(root, '.cook/ingest.intent.json', 'connectome.ingest-intent/v1');
    result = readRecord(root, '.cook/ingest.result.json', 'connectome.ingest-result/v1');
    marker = readRecord(root, 'data/seed.consumed', 'connectome.seed-consumed/v1');
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') fail('E_INGEST_MISSING'); throw e; }
  matchIntent(binding, intent); matchResult(intent, result);
  if (canonical(marker) !== canonical(markerFor(result))) fail('E_SEED_CONFLICT');
  if (marker.outcome !== 'complete') fail('E_INGEST_INCOMPLETE');
  if (!adapters.has(result.adapterId)) fail('E_INGEST_UNQUALIFIED', 4);
  return 'I_CHECK_OK';
}
