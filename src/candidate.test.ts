import { createServer } from 'node:net';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, closeSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { canonical, hash, parseJSON, report, issue, validate, type Records, type Declaration, type Result, type Intent } from './candidate/schema.js';
import { admitFilesystem, exists, flock, fresh, guard, operationLock, preflight, publish, readRecord, reserve, type PublishPoint } from './candidate/io.js';
import { bindings, complete, markerFor, syntheticIngest, type QualifiedAdapter } from './candidate/seed.js';
import { declarationPlan, parseEnv } from './candidate/declaration.js';
import { verify, safeGitHead } from './candidate/verify.js';
import { renderLauncher, runHostBackend } from './backends/host.js';
import { readLockfile } from './lockfile.js';

let dir: string;
const CLI = resolve(import.meta.dir, '../bin/cook');
const agent = { id: '01234567-89ab-cdef-0123-456789abcdef', lineage: 'abcdef01-2345-6789-abcd-ef0123456789' };
const digest = 'sha256:' + 'a'.repeat(64);
const time = '2026-10-30T00:00:00.000Z';
const declaration: Declaration = { schema: 'connectome.declaration/v1', agent, entry: 'recipe.json', recipes: { 'recipe.json': { name: 'Fixture', agent: { systemPrompt: 'Synthetic only' } } }, host: { url: 'https://example.invalid/host', ref: 'main' }, seedRequired: false, dataDir: 'data' };
const intent: Intent = { schema: 'connectome.ingest-intent/v1', operationId: agent.id, agent, configDigest: digest, lockDigest: digest, seedDigest: digest, toolDigest: digest, namespace: 'fixture', adapterId: 'synthetic', dataDir: 'data', startedAt: time };
const result: Result = { ...intent, schema: 'connectome.ingest-result/v1', finishedAt: time, outcome: 'complete', storeIdentity: 'synthetic-store', qualificationId: 'synthetic-only' };
const records: Records = {
  'connectome.declaration/v1': declaration,
  'connectome.deployment/v1': { schema: 'connectome.deployment/v1', agent, desired: { declaration: '.cook/declaration.json', configDigest: digest }, materialized: { lock: 'connectome.lock', lockVersion: 1, lockDigest: digest }, installed: null, running: null, lifecycle: 'held-candidate' },
  'connectome.hold/v1': { schema: 'connectome.hold/v1', agent, state: 'held', scope: 'disposable-candidate', reason: 'candidate-preparation', createdAt: time },
  'connectome.ingest-intent/v1': intent, 'connectome.ingest-result/v1': result,
  'connectome.seed-consumed/v1': markerFor(result),
  'connectome.findings/v1': report('verify', true, [issue('I_HELD', 'hold')]),
  'connectome.observed-running/v1': { schema: 'connectome.observed-running/v1', agent, revision: digest, transaction: { id: agent.id, outcome: 'complete' }, observedAt: time, units: ['fixture.service'], status: 'running' },
};
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cook-candidate-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function cli(args: string[], env: NodeJS.ProcessEnv = {}, cwd = dir) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env.PATH, HOME: dir, ...env }, encoding: 'utf8', input: '', timeout: 15000 });
}
function fixture(seedRequired = false): string {
  const root = join(dir, 'candidate with spaces'); const release = reserve(root);
  try {
    const d = { ...declaration, seedRequired };
    publish(join(root, '.cook/hold.json'), canonical(records['connectome.hold/v1']));
    publish(join(root, '.cook/declaration.json'), canonical(d));
    const lock = { version: 1, backend: 'host', recipePath: join(root, 'recipes/recipe.json'), createdAt: time, connectomeHost: { url: declaration.host.url, ref: 'main', path: join(root, 'app'), commit: 'a'.repeat(40) }, components: [], localExtensions: [], requirements: [], launch: { kind: 'script', script: join(root, 'run.sh') } };
    publish(join(root, 'connectome.lock'), JSON.stringify(lock, null, 2) + '\n');
    publish(join(root, 'connectome.deployment.json'), canonical({ ...records['connectome.deployment/v1'], desired: { declaration: '.cook/declaration.json', configDigest: hash(canonical(d)) }, materialized: { lock: 'connectome.lock', lockVersion: 1, lockDigest: hash(readFileSync(join(root, 'connectome.lock'))) } }));
    writeFileSync(join(root, 'run.sh'), renderLauncher('recipe.json', { candidate: true, hasSidecars: true, envsubstFiles: [] }), { mode: 0o700 });
    mkdirSync(join(root, 'recipes')); writeFileSync(join(root, 'recipes/recipe.json'), canonical(d.recipes['recipe.json']));
  } finally { release(); }
  return root;
}
function adapter(outcome: Result['outcome'] = 'complete') {
  let ingests = 0, validations = 0;
  return {
    id: 'synthetic', get ingests() { return ingests; }, get validations() { return validations; },
    async ingest(root: string, i: Intent): Promise<Result> { ingests++; writeFileSync(join(root, 'data/history'), 'synthetic history', { mode: 0o600 }); return { ...i, schema: 'connectome.ingest-result/v1', outcome, finishedAt: new Date().toISOString(), storeIdentity: 'synthetic-store', qualificationId: 'test-only' }; },
    async revalidate(root: string, r: Readonly<Result>) { validations++; return readFileSync(join(root, 'data/history'), 'utf8') === 'synthetic history' && r.storeIdentity === 'synthetic-store' && r.qualificationId === 'test-only'; },
  };
}
const seedInput = { seedDigest: digest, toolDigest: digest, namespace: 'synthetic', adapterId: 'synthetic' };
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true })) { const full = join(path, entry.name); if (entry.isDirectory()) walk(full); else if (entry.isFile()) out[full.slice(root.length)] = hash(readFileSync(full)); } };
  walk(root); return out;
}

for (const [schema, record] of Object.entries(records) as Array<[keyof Records, Records[keyof Records]]>) {
  test(`${schema}: canonical roundtrip and strict schema discriminator`, () => {
    expect(validate(schema, parseJSON(canonical(record)))).toEqual(record);
    expect(() => validate(schema, { ...record, schema: schema.replace('/v1', '/v2') })).toThrow('E_SCHEMA');
    expect(() => validate(schema, { ...record, unknown: true })).toThrow('E_SCHEMA');
    if (schema !== 'connectome.findings/v1') expect(() => validate(schema, { ...record, supported: [schema] })).toThrow('E_SCHEMA');
  });
  for (const key of Object.keys(record)) test(`${schema}: requires ${key}`, () => {
    const copy = { ...record } as Record<string, unknown>; delete copy[key]; expect(() => validate(schema, copy)).toThrow('E_SCHEMA');
  });
}
test('canonical JSON uses UTF-16 key order, arrays unchanged and rejects duplicate/nonfinite JSON', () => {
  expect(canonical({ z: [2, 1], b: { z: 1, a: 2 }, a: true })).toBe('{"a":true,"b":{"a":2,"z":1},"z":[2,1]}');
  for (const raw of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"n":1e999}', '[NaN]', '{"a":1,}', '[1,]', 'true false', '01']) expect(() => parseJSON(raw)).toThrow('E_SCHEMA');
  expect(() => canonical(NaN)).toThrow('E_SCHEMA');
});
test('configuration changes digest, never identity; installed/running must remain null', () => {
  const d = { ...declaration, seedRequired: true }; expect(hash(canonical(d))).not.toBe(hash(canonical(declaration))); expect(d.agent).toEqual(declaration.agent);
  for (const k of ['installed', 'running']) expect(() => validate('connectome.deployment/v1', { ...records['connectome.deployment/v1'], [k]: {} })).toThrow('E_SCHEMA');
});
test('supported permits future response versions, not empty/missing/duplicate IDs', () => {
  const r = records['connectome.findings/v1'];
  expect(validate(r.schema, { ...r, supported: [r.schema, 'connectome.findings/v2'] }).supported).toHaveLength(2);
  for (const supported of [[], ['connectome.findings/v2'], [r.schema, r.schema]]) expect(() => validate(r.schema, { ...r, supported })).toThrow('E_SCHEMA');
});
test('timestamps, UUIDs, digest strings, nested unknowns and result ordering reject', () => {
  expect(() => validate(intent.schema, { ...intent, agent: { ...agent, unknown: '' } })).toThrow();
  expect(() => validate(intent.schema, { ...intent, agent: { ...agent, id: agent.id.toUpperCase() } })).toThrow();
  expect(() => validate(intent.schema, { ...intent, seedDigest: 'a'.repeat(64) })).toThrow();
  expect(() => validate(intent.schema, { ...intent, startedAt: '2026-02-30T00:00:00.000Z' })).toThrow();
  expect(() => validate(result.schema, { ...result, startedAt: '2026-10-31T00:00:00.000Z' })).toThrow();
});

test('concrete fd lock survives helper exit, rejects contention, releases on close', () => {
  preflight(dir); const path = join(dir, 'lock'); const a = openSync(path, 'w', 0o600), b = openSync(path, 'r+');
  expect(flock(a)).toBe(0); expect(flock(b)).toBe(75); closeSync(a); expect(flock(b)).toBe(0); closeSync(b);
});
test('preflight rejects 0/0 helpers (including pipe substitution) and cleans scratch before R creation', () => {
  expect(() => preflight(dir, () => 0)).toThrow('E_IO'); expect(readdirSync(dir)).toEqual([]);
  const pipeHelper = () => spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] }).status;
  expect(pipeHelper()).toBe(0); expect(() => preflight(dir, pipeHelper)).toThrow('E_IO'); expect(readdirSync(dir)).toEqual([]);
  expect(() => preflight(dir, () => null)).toThrow('E_IO');
});
test('excluded platform/filesystem refusal precedes scratch/candidate writes', () => {
  expect(() => admitFilesystem(dir, 'darwin')).toThrow('E_IO'); expect(() => admitFilesystem('/proc')).toThrow('E_IO'); expect(readdirSync(dir)).toEqual([]);
});
test('operation lock stays on one inode, rejects competing writer and unknown hardlinks', () => {
  const root = fixture(); const path = join(root, '.cook/operation.lock'); const inode = lstatSync(path).ino;
  const release = operationLock(root); expect(() => operationLock(root)).toThrow('E_BUSY'); release(); operationLock(root)(); expect(lstatSync(path).ino).toBe(inode);
  linkSync(path, join(root, 'alias')); expect(() => operationLock(root)).toThrow('E_PATH');
});
test('owner-only files, no-follow roots/data/control paths and unexpected hardlinks', () => {
  const root = fixture(); const p = join(root, '.cook/hold.json'); chmodSync(p, 0o644); expect(() => bindings(root)).toThrow('E_MODE'); chmodSync(p, 0o600);
  linkSync(p, join(root, 'hardlink')); expect(() => bindings(root)).toThrow('E_PATH'); rmSync(join(root, 'hardlink'));
  const link = join(dir, 'linked'); symlinkSync(root, link); expect(() => guard(link)).toThrow('E_PATH');
  rmSync(join(root, 'data'), { recursive: true }); symlinkSync(dir, join(root, 'data')); expect(() => fresh(root)).toThrow('E_PATH');
});
for (const point of ['created', 'written', 'file-synced', 'linked', 'parent-synced', 'temp-removed', 'done'] as PublishPoint[]) test(`publication fault at ${point}: absent or complete, never success/overwrite`, () => {
  const path = join(dir, 'marker'), bytes = canonical(records['connectome.seed-consumed/v1']);
  expect(() => publish(path, bytes, { point: p => { if (p === point) throw new Error('injected crash boundary'); } })).toThrow('E_IO');
  if (exists(path)) { expect(readFileSync(path, 'utf8')).toBe(bytes); expect(lstatSync(path).mode & 0o777).toBe(0o600); expect(() => publish(path, '{}')).toThrow('E_SEED_CONFLICT'); }
  expect(readdirSync(dir).some(n => n.startsWith('.cook-tmp-'))).toBe(false);
});
test('identical qualified publication is idempotent; changed marker cannot replace final inode', () => {
  const path = join(dir, 'marker'); publish(path, '{}'); const inode = lstatSync(path).ino;
  publish(path, '{}', { identical: true }); expect(lstatSync(path).ino).toBe(inode); expect(() => publish(path, '{"changed":true}', { identical: true })).toThrow('E_SEED_CONFLICT'); expect(readFileSync(path, 'utf8')).toBe('{}');
});
for (const kind of ['zero', 'wal', 'dotfile', 'directory', 'symlink', 'malformed-marker', 'marker-directory', 'dangling-marker', 'intent', 'unreadable']) test(`fresh refuses ${kind} before invoking adapter`, async () => {
  const root = fixture(); const data = join(root, 'data');
  if (kind === 'directory') mkdirSync(join(data, 'empty'));
  else if (kind === 'symlink') symlinkSync('missing', join(data, 'link'));
  else if (kind === 'marker-directory') mkdirSync(join(data, 'seed.consumed'));
  else if (kind === 'dangling-marker') symlinkSync('missing', join(data, 'seed.consumed'));
  else if (kind === 'intent') publish(join(root, '.cook/ingest.intent.json'), 'broken');
  else if (kind === 'unreadable') chmodSync(data, 0o000);
  else writeFileSync(join(data, kind === 'malformed-marker' ? 'seed.consumed' : kind === 'dotfile' ? '.state' : kind === 'wal' ? 'store-wal' : 'store'), kind === 'malformed-marker' ? 'partial{' : '');
  const a = adapter(); await expect(syntheticIngest(root, seedInput, a)).rejects.toThrow(kind === 'intent' ? 'E_INGEST_PENDING' : undefined); expect(a.ingests).toBe(0); if (kind === 'unreadable') chmodSync(data, 0o700);
});
test('absent and empty data eligible, without metadata falsely proving adoption', () => {
  fresh(dir); mkdirSync(join(dir, 'data'), { mode: 0o700 }); fresh(dir);
  const r = cli(['seed', 'check', dir, '--json']); expect(r.status).toBe(0); const response = JSON.parse(r.stdout); expect(response.command).toBe('seed-check'); expect(response.activationAllowed).toBe(false); expect(response.findings.some((f: { code: string }) => f.code === 'W_LEGACY_UNMANAGED')).toBe(true);
});
for (const outcome of ['complete', 'partial', 'uncertain'] as const) test(`qualified synthetic ${outcome} result derives exact immutable marker and retains hold`, async () => {
  const root = fixture(true), a = adapter(outcome), before = readFileSync(join(root, '.cook/hold.json'));
  const marker = await syntheticIngest(root, seedInput, a);
  const saved = readRecord(root, '.cook/ingest.result.json', result.schema);
  expect(marker).toEqual(markerFor(saved)); expect(marker.outcome).toBe(outcome); expect(readFileSync(join(root, '.cook/hold.json'))).toEqual(before);
  expect(() => fresh(root)).toThrow('E_SEED_EXISTS'); await expect(syntheticIngest(root, seedInput, a)).rejects.toThrow('E_SEED_EXISTS'); expect(a.ingests).toBe(1);
  expect(verify(root).findings.some(f => f.code === (outcome === 'complete' ? 'E_INGEST_UNQUALIFIED' : 'E_INGEST_INCOMPLETE'))).toBe(true);
});
test('result-before-marker interruption: complete revalidates once, never ingests, is idempotent', async () => {
  const root = fixture(true), a = adapter();
  await expect(syntheticIngest(root, seedInput, a, () => { throw new Error('crash after durable result'); })).rejects.toThrow();
  expect(exists(join(root, 'data/seed.consumed'))).toBe(false); expect(() => fresh(root)).toThrow();
  const before = tree(root), n = a.validations;
  const registry = new Map([[a.id, a]]); const marker = await complete(root, registry); expect(a.ingests).toBe(1); expect(a.validations).toBe(n + 1);
  for (const [path, digest] of Object.entries(before)) expect(hash(readFileSync(join(root, path)))).toBe(digest);
  expect(await complete(root, registry)).toEqual(marker); expect(a.ingests).toBe(1);
  expect(cli(['seed', 'complete', root, '--json']).status).toBe(4);
});
test('no result or unqualified success cannot fabricate even an uncertain marker', async () => {
  const root = fixture(); const a = adapter();
  a.ingest = async () => { throw new Error('external failure'); };
  await expect(syntheticIngest(root, seedInput, a)).rejects.toThrow(); expect(exists(join(root, '.cook/ingest.intent.json'))).toBe(true); expect(exists(join(root, 'data/seed.consumed'))).toBe(false); expect(exists(join(root, '.cook/ingest.result.json'))).toBe(false);
});
for (const poison of ['agent', 'operationId', 'configDigest', 'lockDigest', 'seedDigest', 'toolDigest', 'storeIdentity', 'outcome']) test(`invalid admission ${poison}: no marker`, async () => {
  const root = fixture(), a = adapter(); const ingest = a.ingest;
  a.ingest = async (r, i) => ({ ...await ingest(r, i), [poison]: poison === 'agent' ? { ...agent, lineage: agent.id } : poison === 'operationId' ? agent.lineage : poison === 'outcome' ? 'success' : poison.endsWith('Digest') ? 'sha256:' + 'b'.repeat(64) : 'wrong-store' });
  await expect(syntheticIngest(root, seedInput, a)).rejects.toThrow(); expect(exists(join(root, 'data/seed.consumed'))).toBe(false);
});
test('completion bounds revalidation under lock and expired adapter never publishes later', async () => {
  const root = fixture(), a = adapter(); await expect(syntheticIngest(root, seedInput, a, () => { throw Error('crash'); })).rejects.toThrow();
  let finish: ((value: boolean) => void) | undefined;
  const slow: QualifiedAdapter = { id: a.id, revalidate: async () => { expect(() => operationLock(root)).toThrow('E_BUSY'); return new Promise<boolean>(resolve => { finish = resolve; }); } };
  await expect(complete(root, new Map([[slow.id, slow]]), 20)).rejects.toThrow('E_INGEST_INCOMPLETE'); finish?.(true); await new Promise(r => setTimeout(r, 30)); expect(exists(join(root, 'data/seed.consumed'))).toBe(false); operationLock(root)();
});
test('completion contention, changed durable bytes and marker conflict do not rewrite history', async () => {
  const root = fixture(), a = adapter(); await syntheticIngest(root, seedInput, a); const registry = new Map([[a.id, a]]);
  const release = operationLock(root); await expect(complete(root, registry)).rejects.toThrow('E_BUSY'); release();
  const path = join(root, 'data/seed.consumed'); writeFileSync(path, '{}'); await expect(complete(root, registry)).rejects.toThrow('E_SEED_CONFLICT'); expect(readFileSync(path, 'utf8')).toBe('{}');
  writeFileSync(join(root, 'connectome.lock'), '{}'); await expect(complete(root, registry)).rejects.toThrow('E_DIGEST'); expect(readFileSync(join(root, 'data/history'), 'utf8')).toBe('synthetic history');
});

test('qualify production lock preflight and non-leaking descriptors under Node and Bun', async () => {
  const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, 'candidate/io.ts')], outdir: join(dir, 'compiled'), target: 'node' }); expect(built.success).toBe(true);
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, `import { preflight, flock } from ${JSON.stringify(built.outputs[0]!.path)};
import { openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
preflight(${JSON.stringify(dir)});
const path=${JSON.stringify(join(dir, 'leak.lock'))}; const fd=openSync(path,'w',0o600);
if(flock(fd)!==0) process.exit(1);
const child=spawnSync('/bin/sh',['-c','for f in /proc/self/fd/*; do readlink "$f" || :; done'],{encoding:'utf8'});
if(child.stdout.includes(path)) process.exit(2);
closeSync(fd); console.log('0/75/0; no descriptor leak');`);
  for (const runtime of ['node', process.execPath]) {
    const r = spawnSync(runtime, [probe], { encoding: 'utf8', timeout: 15000 }); expect(r.status).toBe(0); expect(r.stdout).toContain('0/75/0; no descriptor leak');
  }
});
test('kernel releases retained operation lock when owning process dies', async () => {
  const root = fixture(); const childFile = join(dir, 'lock-owner.ts');
  writeFileSync(childFile, `import {operationLock} from ${JSON.stringify(resolve(import.meta.dir, 'candidate/io.ts'))}; operationLock(${JSON.stringify(root)}); console.log('locked'); setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [childFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  try { await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(Error('early exit'))); }); expect(() => operationLock(root)).toThrow('E_BUSY'); }
  finally { child.kill('SIGKILL'); await new Promise(r => child.once('exit', r)); }
  operationLock(root)();
});
test('multiple processes publish exactly one complete immutable file', async () => {
  const path = join(dir, 'race.json'), script = join(dir, 'publish.ts');
  writeFileSync(script, `import {publish} from ${JSON.stringify(resolve(import.meta.dir, 'candidate/io.ts'))}; try { publish(process.argv[2], JSON.stringify({writer:process.argv[3],payload:'x'.repeat(100000)})); } catch(e) { process.exit(e.code==='E_SEED_CONFLICT'?4:3); }`);
  const children = ['one', 'two', 'three'].map(id => spawn(process.execPath, [script, path, id], { stdio: 'ignore' }));
  let sampling = true, torn = false;
  const reader = (async () => { while (sampling) { if (exists(path)) { try { const v = JSON.parse(readFileSync(path, 'utf8')); if (v.payload.length !== 100000) torn = true; } catch { torn = true; } } await new Promise(r => setTimeout(r, 1)); } })();
  const results = await Promise.all(children.map(c => new Promise<number | null>(r => c.on('exit', r))));
  sampling = false; await reader; expect(torn).toBe(false);
  expect(results.filter(n => n === 0)).toHaveLength(1); expect(results.filter(n => n === 4)).toHaveLength(2);
  const json = JSON.parse(readFileSync(path, 'utf8')); expect(json.payload.length).toBe(100000); expect(lstatSync(path).mode & 0o777).toBe(0o600); expect(lstatSync(path).nlink).toBe(1);
});
for (const point of ['file-synced', 'linked', 'parent-synced', 'temp-removed'] as PublishPoint[]) test(`real process death at publication ${point} leaves absent/whole bytes`, () => {
  const path = join(dir, 'crashed.json'), script = join(dir, 'crash.ts');
  writeFileSync(script, `import {publish} from ${JSON.stringify(resolve(import.meta.dir, 'candidate/io.ts'))}; publish(${JSON.stringify(path)}, '${canonical(records['connectome.hold/v1'])}', {point:p=>{if(p===${JSON.stringify(point)}) process.kill(process.pid,'SIGKILL')}});`);
  const child = spawnSync(process.execPath, [script], { timeout: 5000 }); expect(child.signal).toBe('SIGKILL');
  if (exists(path)) { expect(readFileSync(path, 'utf8')).toBe(canonical(records['connectome.hold/v1'])); expect(lstatSync(path).mode & 0o777).toBe(0o600); }
  if (point === 'file-synced') expect(exists(path)).toBe(false);
  if (point === 'linked' || point === 'parent-synced') expect(() => publish(path, canonical(records['connectome.hold/v1']), { identical: true })).toThrow('E_PATH'); // Unknown surviving temp hardlink: fail closed.
});

function sentinels(): { env: NodeJS.ProcessEnv; sentinel: string } {
  const bin = join(dir, 'fake-bin'); mkdirSync(bin, { recursive: true });
  const sentinel = join(dir, 'effects');
  for (const name of ['docker', 'bun', 'envsubst', 'git']) writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> '${sentinel}'\nexit 99\n`, { mode: 0o755 });
  return { sentinel, env: { PATH: `${bin}:${process.env.PATH}`, COOK_SKIP_SIDECARS: '1' } };
}
for (const metadata of ['intact', 'missing-lock', 'removed-controls', 'moved']) test(`actual candidate launcher refuses before .env/sidecars/templates/data: ${metadata}`, () => {
  let root = fixture(); const { env, sentinel } = sentinels();
  writeFileSync(join(root, '.env'), `echo env >> '${sentinel}'\n`); writeFileSync(join(root, 'config.tmpl'), 'unchanged');
  if (metadata === 'missing-lock') rmSync(join(root, 'connectome.lock'));
  if (metadata === 'removed-controls') { rmSync(join(root, '.cook'), { recursive: true }); rmSync(join(root, 'connectome.deployment.json')); }
  if (metadata === 'moved') { const moved = join(dir, 'moved root'); renameSync(root, moved); root = moved; }
  const before = tree(root);
  for (let n = 0; n < 3; n++) { const r = spawnSync(join(root, 'run.sh'), ['--force', '--clear'], { env: { ...env, DATA_DIR: join(dir, 'external') }, encoding: 'utf8' }); expect(r.status).toBe(4); expect(r.stderr).toContain('E_HELD'); }
  expect(tree(root)).toEqual(before); expect(exists(sentinel)).toBe(false); expect(exists(join(dir, 'external'))).toBe(false);
  const r = cli(['run', root, '--rebuild'], env); expect(r.status).toBe(4); expect(exists(sentinel)).toBe(false);
});
test('new legacy launcher hold-entry guard precedes every launch effect', () => {
  const root = fixture(); const { env, sentinel } = sentinels();
  writeFileSync(join(root, 'run.sh'), renderLauncher('recipe.json', { hasSidecars: true, envsubstFiles: [{ tmpl: 'x.tmpl', target: 'x', mode: '600' }] }), { mode: 0o700 });
  writeFileSync(join(root, '.env'), `echo env >> '${sentinel}'\n`);
  const r = spawnSync(join(root, 'run.sh'), [], { env, encoding: 'utf8' }); expect(r.status).toBe(4); expect(exists(sentinel)).toBe(false);
});
for (const flags of [[], ['--rebuild'], ['--strict'], ['--env-file', 'not-readable'], ['--pin-refs']]) test(`recipe selection cannot bypass candidate hold: ${flags.join(' ')}`, () => {
  const root = fixture(); const { env, sentinel } = sentinels();
  writeFileSync(join(dir, 'recipe.json'), canonical(declaration.recipes['recipe.json']));
  let r = cli(['run', 'recipe.json', '--out', root, ...flags], env); expect(r.status).toBe(4);
  renameSync(root, join(dir, 'fixture-cook'));
  r = cli(['run', 'recipe.json', ...flags], env); expect(r.status).toBe(4); expect(exists(sentinel)).toBe(false);
});
for (const hold of [false, true]) test(`held install (--hold=${hold}) refuses before resolver, env-file, pinning, prompt or build`, () => {
  const root = fixture(); const { env, sentinel } = sentinels(); const before = tree(root);
  const r = cli(['install', 'https://example.invalid/no-read', '--out', root, '--env-file', '/dev/zero', '--pin-refs', ...(hold ? ['--hold', '--agent-id', agent.id, '--lineage-id', agent.lineage, '--no-prompts', '--yes', '--json'] : [])], env);
  expect(r.status).toBe(4); expect(exists(sentinel)).toBe(false); expect(tree(root)).toEqual(before);
});
test('clear always refuses and never rewrites hold or any evidence', () => {
  const root = fixture(); const before = tree(root);
  const r = cli(['hold', root, '--clear', '--json']); expect(r.status).toBe(4); expect(JSON.parse(r.stdout).command).toBe('hold-clear'); expect(JSON.parse(r.stdout).findings[0].code).toBe('E_CLEAR_UNSUPPORTED'); expect(tree(root)).toEqual(before);
});
test('check --json exits 2 with empty stdout before reading any recipe', () => {
  for (const args of [['check', '--json'], ['check', 'https://example.invalid/no-network', '--json']]) {
    const r = cli(args); expect(r.status).toBe(2); expect(r.stdout).toBe(''); expect(r.stderr).toContain('E_JSON_UNSUPPORTED');
  }
});
test('schema negotiation, unknown options and missing explicit prepare flags are no-effect JSON errors', () => {
  for (const cmd of ['verify', 'hold']) {
    const r = cli([cmd, dir, '--schema', 'connectome.findings/v2']); expect(r.status).toBe(2); const parsed = JSON.parse(r.stdout); expect(parsed.supported).toEqual(['connectome.findings/v1']); expect(parsed.findings[0].code).toBe('E_SCHEMA');
    expect(cli([cmd, dir, '--force', '--json']).status).toBe(1);
  }
  const args = ['install', 'no-read', '--hold', '--out', join(dir, 'new'), '--agent-id', agent.id, '--lineage-id', agent.lineage, '--json'];
  expect(cli(args).status).toBe(1); expect(exists(join(dir, 'new'))).toBe(false);
  const r = cli([...args, '--yes', '--no-prompts', '--schema', 'connectome.findings/v2']); expect(r.status).toBe(2); expect(exists(join(dir, 'new'))).toBe(false);
});
test('strict env subset never executes unsupported shell syntax', () => {
  expect(parseEnv("export X='a'\\''b'\n", true).X).toBe("a'b");
  for (const text of ['X=$(touch file)', 'echo owned', 'X="${AMBIENT}"', 'X=1; touch file', 'export X=unquoted']) expect(() => parseEnv(text, true)).toThrow('E_ENV_FORMAT');
  expect(() => parseEnv('DATA_DIR=/external')).toThrow('E_SCOPE');
});

test('offline verify aggregates drift/requirements/credentials/handshakes/seed and leaves all bytes unchanged', () => {
  const root = fixture(true);
  const d: Declaration = { ...declaration, seedRequired: true, recipes: { 'recipe.json': { ...declaration.recipes['recipe.json']!, requirements: { sdk: { required: true } }, mcpServers: { websocket: { url: 'ws://localhost:1234', env: { KEY: '${PRIVATE_KEY}' } } } } } };
  writeFileSync(join(root, '.cook/declaration.json'), canonical(d)); writeFileSync(join(root, 'recipes/recipe.json'), '{}');
  const { env, sentinel } = sentinels(); const before = tree(root);
  const r = cli(['verify', root, '--json'], { ...env, ANTHROPIC_API_KEY: 'AMBIENT_MUST_NOT_SATISFY', GIT_ASKPASS: join(dir, 'fake-bin/bun'), SSH_ASKPASS: join(dir, 'fake-bin/bun'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: join(dir, 'fake-bin/bun') });
  expect(r.status).toBe(2); const response = validate('connectome.findings/v1', JSON.parse(r.stdout)); const codes = response.findings.map(f => f.code);
  for (const code of ['E_DIGEST', 'E_CONFIG_DRIFT', 'E_REQUIREMENT_MISSING', 'W_CREDENTIAL_MISSING', 'E_HANDSHAKE_MISSING', 'E_INGEST_MISSING']) expect(codes).toContain(code);
  expect(r.stdout + r.stderr).not.toContain('AMBIENT_MUST_NOT_SATISFY'); expect(exists(sentinel)).toBe(false); expect(tree(root)).toEqual(before);
  const human = cli(['verify', root], env); expect(human.status).toBe(2); for (const code of codes) expect(human.stdout).toContain(code);
});
test('read-only Git invocation disables fsmonitor and ambient askpass/config injection', () => {
  const checkout = join(dir, 'checkout'); mkdirSync(checkout);
  const git = (args: string[]) => spawnSync('/usr/bin/git', args, { cwd: checkout, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  expect(git(['init', '-q']).status).toBe(0); expect(git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']).status).toBe(0);
  const sentinel = join(dir, 'git-hook-ran'), hook = join(dir, 'hook'); writeFileSync(hook, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o700 }); git(['config', 'core.fsmonitor', hook]);
  const saved = { ...process.env };
  try {
    process.env.GIT_ASKPASS = hook; process.env.SSH_ASKPASS = hook; process.env.GIT_CONFIG_COUNT = '1'; process.env.GIT_CONFIG_KEY_0 = 'core.fsmonitor'; process.env.GIT_CONFIG_VALUE_0 = hook;
    expect(safeGitHead(checkout)).toMatch(/^[a-f0-9]{40}$/); expect(exists(sentinel)).toBe(false);
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});

function prepareFixture(secret?: string) {
  const bin = join(dir, 'tools'); mkdirSync(bin); const effects = join(dir, 'tools-called');
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\nimport {mkdirSync,writeFileSync,appendFileSync} from 'node:fs'; import {join} from 'node:path'; const a=process.argv.slice(2); appendFileSync(${JSON.stringify(effects)},a[0]+'\\n'); if(a[0]==='clone'){mkdirSync(join(a[2],'src'),{recursive:true});writeFileSync(join(a[2],'src/index.ts'),'// synthetic');} if(a[0]==='rev-parse'||a[0]==='ls-remote') console.log('${'a'.repeat(40)}');`, { mode: 0o700 });
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const recipe = join(dir, 'recipe.json'); writeFileSync(recipe, canonical(declaration.recipes['recipe.json']));
  const envFile = join(dir, 'private.env'); if (secret) writeFileSync(envFile, `ANTHROPIC_API_KEY=${secret}\n`, { mode: 0o600 });
  const root = join(dir, 'prepared'); const args = ['install', recipe, '--hold', '--out', root, '--agent-id', agent.id, '--lineage-id', agent.lineage, '--no-prompts', '--yes', '--json', ...(secret ? ['--env-file', envFile] : [])];
  const env = { PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_API_KEY: 'IGNORED_AMBIENT_SECRET' };
  return { root, args, env, effects, recipe };
}
test('production prepare path creates private held candidate and unchanged v1 lock, with secret-free metadata/output', () => {
  const secret = 'FILE_ONLY_SYNTHETIC_SECRET', f = prepareFixture(secret);
  const r = cli(f.args, f.env); expect(r.status).toBe(0); expect(r.stderr).toBe(''); const response = JSON.parse(r.stdout); expect(response.command).toBe('prepare'); expect(response.held).toBe(true); expect(response.activationAllowed).toBe(false);
  for (const path of ['.cook/hold.json', '.cook/declaration.json', '.cook/operation.lock', 'connectome.deployment.json', 'connectome.lock']) {
    expect(lstatSync(join(f.root, path)).mode & 0o777).toBe(0o600); const text = readFileSync(join(f.root, path), 'utf8'); expect(text).not.toContain(secret); expect(text).not.toContain('IGNORED_AMBIENT_SECRET'); expect(text).not.toContain('supported');
  }
  for (const path of ['', '.cook', 'data']) expect(lstatSync(join(f.root, path)).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(f.root, 'run.sh')).mode & 0o777).toBe(0o700); expect(readFileSync(join(f.root, '.env'), 'utf8')).toContain(secret);
  expect(readLockfile(f.root)?.version).toBe(1); const b = bindings(f.root); expect(b.envelope.installed).toBeNull(); expect(b.envelope.running).toBeNull();
  expect(r.stdout + r.stderr).not.toContain(secret); expect(cli(['hold', f.root, '--json']).status).toBe(0);
});
test('ambient credentials ignored; fresh candidates never inherit production DATA_DIR', () => {
  const f = prepareFixture(); const r = cli(f.args, f.env); expect(r.status).toBe(0); expect(exists(join(f.root, '.env'))).toBe(false);
  const next = f.args.map(a => a === f.root ? join(dir, 'other') : a); expect(cli(next, { ...f.env, DATA_DIR: '/production' }).status).toBe(2); expect(exists(join(dir, 'other'))).toBe(false);
});
for (const fault of ['inline-secret', 'fleet', 'duplicate-key', 'build-failed']) test(`preparation ${fault} cannot publish envelope or lose hold`, () => {
  const f = prepareFixture();
  if (fault === 'inline-secret') writeFileSync(f.recipe, canonical({ ...declaration.recipes['recipe.json'], apiKey: 'DO_NOT_SERIALIZE' }));
  if (fault === 'fleet') writeFileSync(f.recipe, canonical({ ...declaration.recipes['recipe.json'], modules: { fleet: { children: [{ name: 'child', recipe: 'https://example.invalid/never-fetch' }] } } }));
  if (fault === 'duplicate-key') writeFileSync(f.recipe, '{"name":"a","name":"b","agent":{"systemPrompt":"x"}}');
  if (fault === 'build-failed') writeFileSync(join(dirname(f.effects), 'tools/bun'), '#!/bin/sh\nexit 5\n', { mode: 0o700 });
  const r = cli(f.args, f.env); expect(r.status).not.toBe(0); expect(exists(join(f.root, '.cook/hold.json'))).toBe(true); expect(exists(join(f.root, 'connectome.deployment.json'))).toBe(false); expect(r.stdout + r.stderr).not.toContain('DO_NOT_SERIALIZE');
  if (fault !== 'build-failed') expect(exists(f.effects)).toBe(false);
});
test('moved candidate verification detects stale absolute materialization/launch paths', () => {
  const root = fixture(); const moved = join(dir, 'moved'); renameSync(root, moved);
  const response = verify(moved); expect(response.findings.some(f => f.code === 'E_PATH' && f.subject === 'launch')).toBe(true);
});

test('completion revalidates durable history, not just a matching result record', async () => {
  const root = fixture(), a = adapter(); await expect(syntheticIngest(root, seedInput, a, () => { throw Error('after result'); })).rejects.toThrow();
  rmSync(join(root, 'data/history'));
  await expect(complete(root, new Map([[a.id, a]]))).rejects.toThrow('E_INGEST_INCOMPLETE'); expect(exists(join(root, 'data/seed.consumed'))).toBe(false);
});
for (const poison of ['qualification', 'tuple', 'schema']) test(`completion poisoned saved ${poison} cannot publish`, async () => {
  const root = fixture(), a = adapter(); await expect(syntheticIngest(root, seedInput, a, () => { throw Error('after result'); })).rejects.toThrow();
  const path = join(root, '.cook/ingest.result.json'); const saved = JSON.parse(readFileSync(path, 'utf8'));
  if (poison === 'qualification') saved.qualificationId = 'unavailable';
  if (poison === 'tuple') saved.lockDigest = 'sha256:' + 'f'.repeat(64);
  if (poison === 'schema') saved.schema = 'connectome.ingest-result/v2';
  writeFileSync(path, canonical(saved)); const before = tree(root);
  await expect(complete(root, new Map([[a.id, a]]))).rejects.toThrow(); expect(exists(join(root, 'data/seed.consumed'))).toBe(false); expect(tree(root)).toEqual(before);
});
test('actual process death after durable result releases lock; completion does not ingest again', async () => {
  const root = fixture(), script = join(dir, 'ingest-owner.ts');
  writeFileSync(script, `import {syntheticIngest} from ${JSON.stringify(resolve(import.meta.dir, 'candidate/seed.ts'))};
import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
const adapter={id:'synthetic',async revalidate(){return true},async ingest(root,intent){writeFileSync(join(root,'data/history'),'synthetic history',{mode:0o600}); return {...intent,schema:'connectome.ingest-result/v1',finishedAt:new Date().toISOString(),outcome:'complete',storeIdentity:'synthetic-store',qualificationId:'test-only'}}};
await syntheticIngest(${JSON.stringify(root)},${JSON.stringify(seedInput)},adapter,()=>process.kill(process.pid,'SIGKILL'));`);
  const child = spawnSync(process.execPath, [script], { timeout: 10000 }); expect(child.signal).toBe('SIGKILL');
  expect(exists(join(root, '.cook/ingest.result.json'))).toBe(true); expect(exists(join(root, 'data/seed.consumed'))).toBe(false);
  const a = adapter(); await complete(root, new Map([[a.id, a]])); expect(a.validations).toBe(1); expect(a.ingests).toBe(0);
});
test('completion default registry cannot admit arbitrary operator-supplied success JSON', async () => {
  const root = fixture(), a = adapter(); await expect(syntheticIngest(root, seedInput, a, () => { throw Error('after result'); })).rejects.toThrow();
  await expect(complete(root)).rejects.toThrow('E_INGEST_UNQUALIFIED'); expect(exists(join(root, 'data/seed.consumed'))).toBe(false);
  const r = cli(['seed', 'complete', root, '--adapter', 'synthetic', '--json']); expect(r.status).toBe(1);
  expect(cli(['seed', 'import', root, '--json']).status).toBe(1);
});
test('unsupported cross-device/durability publication never falls back to copy', () => {
  for (const code of ['EXDEV', 'ENOTSUP', 'EIO']) {
    const path = join(dir, code); expect(() => publish(path, '{}', { point: p => { if (p === 'file-synced') throw Object.assign(Error(code), { code }); } })).toThrow('E_IO'); expect(exists(path)).toBe(false);
  }
});
test('candidate acquisition ignores ambient askpass/config channels, including pinning', () => {
  const f = prepareFixture(); const path = join(dir, 'askpass'); const sentinel = join(dir, 'askpass-ran');
  writeFileSync(path, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o700 });
  // Fake git records exactly the environment it was handed; it cannot fetch.
  const git = join(dir, 'tools/git'); const source = readFileSync(git, 'utf8'); writeFileSync(git, source + `\nwriteFileSync(${JSON.stringify(join(dir, 'git-environment'))},JSON.stringify(process.env));`);
  const r = cli([...f.args, '--pin-refs'], { ...f.env, GIT_ASKPASS: path, SSH_ASKPASS: path, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: path });
  expect(r.status).toBe(0); expect(exists(sentinel)).toBe(false); const env = JSON.parse(readFileSync(join(dir, 'git-environment'), 'utf8')); expect(env.GIT_ASKPASS).toBe('/bin/false'); expect(env.GIT_TERMINAL_PROMPT).toBe('0'); expect(env.SSH_ASKPASS).toBeUndefined(); expect(env.GIT_CONFIG_COUNT).toBeUndefined();
});
test('handshake consumers still enumerate when independent declaration detection fails', () => {
  const root = fixture(), d = structuredClone(declaration);
  d.recipes['recipe.json']!.extensions = { missing: { kind: 'module', path: '/absolute/unbakeable.ts' } };
  d.recipes['recipe.json']!.mcpServers = { ws: { url: 'ws://localhost:1234' } };
  writeFileSync(join(root, '.cook/declaration.json'), canonical(d));
  const codes = verify(root).findings.map(f => f.code); expect(codes).toContain('E_SCOPE'); expect(codes).toContain('E_HANDSHAKE_MISSING');
});
test('no-effect hold clear even when presented with a synthetic error-free findings response', () => {
  const root = fixture();
  const synthetic = report('verify', true, [issue('I_CHECK_OK', 'materialization', 'fixture', 'Synthetic static checks passed.')]);
  expect(validate(synthetic.schema, synthetic).status).toBe('ok'); expect(synthetic.activationAllowed).toBe(false);
  const before = tree(root); expect(cli(['hold', root, '--clear', '--json']).status).toBe(4); expect(tree(root)).toEqual(before);
});

test('new guards preserve legacy symlink recipe/install behavior without adopting candidates', () => {
  const recipe = join(dir, 'recipe.json'); writeFileSync(recipe, canonical(declaration.recipes['recipe.json'])); const link = join(dir, 'recipe-link.json'); symlinkSync(recipe, link); expect(() => guard(link)).not.toThrow();
  const root = join(dir, 'legacy'); mkdirSync(root); writeFileSync(join(root, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 }); const linkedRoot = join(dir, 'legacy-link'); symlinkSync(root, linkedRoot); expect(() => guard(linkedRoot)).not.toThrow();
  mkdirSync(join(root, '.cook')); expect(() => guard(linkedRoot)).toThrow('E_PATH');
});

test('socket entry is history-or-uncertainty and never invokes ingest', async () => {
  const root = fixture(), server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(join(root, 'data/socket'), resolve); });
  try { const a = adapter(); await expect(syntheticIngest(root, seedInput, a)).rejects.toThrow('E_HISTORY_EXISTS'); expect(a.ingests).toBe(0); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('tool success without a qualified result is not a seed receipt', async () => {
  const root = fixture(), a = adapter(); a.ingest = async () => undefined as unknown as Result;
  await expect(syntheticIngest(root, seedInput, a)).rejects.toThrow('E_SCHEMA'); expect(exists(join(root, '.cook/ingest.intent.json'))).toBe(true); expect(exists(join(root, 'data/seed.consumed'))).toBe(false);
});


test('seed check refuses pending intent with exit 4 and E_INGEST_PENDING', () => {
  const root = fixture(); publish(join(root, '.cook/ingest.intent.json'), 'interrupted');
  const before = tree(root), r = cli(['seed', 'check', root, '--json']);
  expect(r.status).toBe(4);
  expect(JSON.parse(r.stdout).findings.map((f: { code: string }) => f.code)).toContain('E_INGEST_PENDING');
  expect(tree(root)).toEqual(before);
});
test('candidate template value bag excludes ambient sentinel without env-file', () => {
  const f = prepareFixture(), sentinel = 'TEMPLATE_AMBIENT_MUST_NOT_LEAK';
  writeFileSync(f.recipe, canonical({ ...declaration.recipes['recipe.json'], containerTemplateFiles: [
    { hostPath: 'cfg.conf', inContainer: '/etc/cfg.conf', template: 'KEY=${AMBIENT_SECRET}' },
  ] }));
  const r = cli([...f.args, '--allow-incomplete-templates'], { ...f.env, AMBIENT_SECRET: sentinel });
  expect(r.status).toBe(0);
  expect(readFileSync(join(f.root, 'etc/cfg.conf'), 'utf8')).toBe('KEY=');
  expect(r.stdout + r.stderr).not.toContain(sentinel);
});
test('candidate sidecar secret excludes ambient sentinel without env-file', () => {
  const f = prepareFixture(), sentinel = 'SIDECAR_AMBIENT_MUST_NOT_LEAK';
  writeFileSync(f.recipe, canonical({ ...declaration.recipes['recipe.json'], services: [
    { name: 'fixture', image: 'example.invalid/fixture:synthetic', secrets: ['SIDECAR_SECRET'] },
  ] }));
  const r = cli(f.args, { ...f.env, SIDECAR_SECRET: sentinel });
  expect(r.status).toBe(0); expect(exists(join(f.root, 'SIDECAR_SECRET'))).toBe(false);
  expect(r.stdout + r.stderr).not.toContain(sentinel);
});
test('direct legacy host backend refuses candidate before inspecting sources', async () => {
  const root = fixture(), before = tree(root), plan = declarationPlan(declaration, root);
  let sourceReads = 0;
  Object.defineProperty(plan, 'sources', { get() { sourceReads++; throw Error('unexpected source inspection'); } });
  await expect(runHostBackend(plan, { candidate: false, installDir: root, noPrompts: true, yes: true,
    chRepoUrl: declaration.host.url, chRef: 'main', allowIncompleteTemplates: false,
  })).rejects.toThrow('E_HELD');
  expect(sourceReads).toBe(0); expect(tree(root)).toEqual(before);
});
test('completion caps oversized revalidation timeout at 30 seconds', async () => {
  const root = fixture(), a = adapter();
  await expect(syntheticIngest(root, seedInput, a, () => { throw Error('after result'); })).rejects.toThrow();
  const before = tree(root), delays: number[] = [], realTimer = globalThis.setTimeout;
  // Observe the production timer's requested delay, but fire immediately.
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
    delays.push(delay); return realTimer(callback, 0);
  }) as typeof setTimeout);
  try {
    const slow: QualifiedAdapter = { id: a.id, async revalidate() {
      expect(() => operationLock(root)).toThrow('E_BUSY'); return new Promise<boolean>(() => {});
    } };
    await expect(complete(root, new Map([[slow.id, slow]]), 60_000)).rejects.toThrow('E_INGEST_INCOMPLETE');
    expect(delays).toEqual([30_000]); expect(tree(root)).toEqual(before); operationLock(root)();
  } finally { timer.mockRestore(); }
});
test('check help takes precedence over json refusal', () => {
  const r = cli(['check', '--help', '--json']);
  expect(r.status).toBe(0); expect(r.stdout).toContain('Usage:\n  cook check <recipe-path-or-url> [flags]'); expect(r.stderr).toBe('');
});

// Mock only recipe transport; execute the real CLI with closed stdin and fake
// build tools. No test network server or external fetch is involved.
function remoteInstall(recipe: unknown, args: string[], env: NodeJS.ProcessEnv, status = 200) {
  const calls = join(dir, 'fetch-calls'), script = join(dir, 'remote-cli.ts');
  writeFileSync(script, `import {appendFileSync} from 'node:fs';
    globalThis.fetch = async url => {
      appendFileSync(${JSON.stringify(calls)}, String(url)+'\\n');
      return new Response(${JSON.stringify(JSON.stringify(recipe))}, {status:${status}});
    };
    const {main} = await import(${JSON.stringify(resolve(import.meta.dir, 'cli.ts'))});
    await main(${JSON.stringify(['install', 'https://example.invalid/not-the-recipe-name.json', ...args])});`);
  const r = spawnSync(process.execPath, [script], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ...env }, input: '', encoding: 'utf8', timeout: 15000 });
  return { r, calls: readFileSync(calls, 'utf8').trim().split('\n') };
}
test('default held install refuses after parent read before children credentials prompts or tools at EOF', () => {
  const f = prepareFixture(), root = join(dir, '.connectome/installs/fixture');
  mkdirSync(dirname(root), { recursive: true }); renameSync(fixture(), root);
  const before = tree(root);
  const { r, calls } = remoteInstall({ ...declaration.recipes['recipe.json'],
    modules: { fleet: { children: [{ name: 'child', recipe: 'never-read-child.json' }] } },
    mcpServers: { fixture: { command: 'npx', args: ['fixture'], env: { KEY: '${PROMPT_SENTINEL}' } } },
  }, ['--env-file', join(dir, 'never-read.env'), '--pin-refs'], f.env);
  expect(r.status).toBe(4); expect(r.stderr).toContain('E_HELD');
  expect(r.stdout).toBe('-> walking recipe https://example.invalid/not-the-recipe-name.json\n');
  expect(calls).toEqual(['https://example.invalid/not-the-recipe-name.json']);
  expect(exists(f.effects)).toBe(false); expect(tree(root)).toEqual(before);
});
test('default legacy install reuses parent read with exactly one remote fetch', () => {
  const f = prepareFixture();
  const { r, calls } = remoteInstall(declaration.recipes['recipe.json'], ['--no-prompts', '--yes'], f.env);
  expect(r.status).toBe(0); expect(calls).toEqual(['https://example.invalid/not-the-recipe-name.json']);
  expect(r.stdout.split('-> walking recipe ')).toHaveLength(2);
  expect(exists(join(dir, '.connectome/installs/fixture/connectome.lock'))).toBe(true);
  expect(exists(f.effects)).toBe(true);
});
test('default install parent fetch requiring credentials fails closed without prompting', () => {
  const f = prepareFixture();
  const { r, calls } = remoteInstall({}, [], f.env, 401);
  expect(r.status).toBe(2);
  expect(r.stdout).toBe('-> walking recipe https://example.invalid/not-the-recipe-name.json\n'); expect(calls).toHaveLength(1);
  expect(exists(f.effects)).toBe(false); expect(exists(join(dir, '.connectome'))).toBe(false);
});

for (const command of ['install', 'build']) test(`${command} help precedes held output guard`, () => {
  const root = fixture(), before = tree(root);
  const plain = cli([command, '--help']);
  const held = cli([command, '--out', root, '--help']);
  expect(plain.status).toBe(0); expect(plain.stdout).toContain(`cook ${command}`);
  expect(held.status).toBe(0); expect(held.stdout).toBe(plain.stdout); expect(held.stderr).toBe('');
  expect(tree(root)).toEqual(before);
});
