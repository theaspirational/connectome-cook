import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readLockfile } from './lockfile.js';
import { exportManifest, extendEnvelope, materializationV1, readObservation } from './candidate/manifest.js';
import { canonical, deploymentRevision, hash, parseJSON, validate, type Envelope, type Manifest, type RunningObservation } from './candidate/schema.js';

const historical = resolve(import.meta.dir, '../test/fixtures/deployment-v1');
const lockBytes = readFileSync(join(historical, 'connectome.lock'), 'utf8');
const legacy = validate('connectome.deployment/v1', parseJSON(readFileSync(join(historical, 'envelope.json'), 'utf8')));
const lock = materializationV1(legacy, lockBytes);
const digest = hash('synthetic nonsecret artifact');
const secret = 'synthetic-private-value-do-not-export';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cook-manifest-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function bindings(profiles = ['default'], split = false): Omit<Manifest, 'revision'> {
  return {
    configRevision: 'c'.repeat(40), profiles,
    roles: [
      ...(['config', 'runtime', 'state', 'workspace', 'credentials'] as const).map(kind => ({ name: kind, kind, path: `/srv/fixture/${kind}`, owner: { uid: 1000, gid: 1000 } })),
      ...(split ? [{ name: 'connector-state', kind: 'state' as const, path: '/var/lib/fixture/connector', owner: { uid: 1000, gid: 1000 } }] : []),
    ],
    providers: profiles.map(consumer => ({ name: `provider-${consumer}`, required: true, consumer, role: 'credentials', destination: `${consumer}/auth.json` })),
    units: profiles.map(profile => ({ name: `fixture-${profile}.service`, scope: 'user', profile, artifacts: ['host', 'configuration'], after: [] })),
    artifacts: [{ name: 'host', role: 'runtime', path: 'app', digest }, { name: 'configuration', role: 'config', path: 'recipe.json', digest }],
  };
}
function manifest(b = bindings(), bytes = lockBytes): Envelope {
  return extendEnvelope({ ...legacy, materialized: { ...legacy.materialized, lockDigest: hash(bytes) } }, bytes, b);
}
function reseal(e: Envelope): Envelope { e.manifest!.revision = deploymentRevision(e); return e; }
function cli(args: string[]) {
  return spawnSync(process.execPath, [resolve(import.meta.dir, '../bin/cook'), 'deployment', ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', API_TOKEN: secret } });
}
function observation(e: Envelope): RunningObservation {
  return { schema: 'connectome.observed-running/v1', agent: e.agent, revision: e.manifest!.revision, transaction: { id: e.agent.id, outcome: 'complete' }, observedAt: '2026-11-01T00:00:00.000Z', units: e.manifest!.units.map(u => u.name), status: 'running' };
}

for (const [label, profiles, split] of [
  ['single user unit', ['default'], false],
  ['two profiles', ['primary', 'secondary'], false],
  ['split state roots', ['default'], true],
] as const) test(`${label}: complete envelope roundtrip and explicit v1 adaptation`, () => {
  const b = bindings([...profiles], split);
  if (split) {
    b.units[0]!.scope = 'system'; b.units[0]!.after = ['fixture-sidecar.service'];
    b.units.push({ name: 'fixture-sidecar.service', scope: 'system', profile: 'default', artifacts: ['host'], after: [] });
  }
  const e = manifest(b);
  const exported = exportManifest(e, lockBytes);
  expect(validate('connectome.deployment/v1', parseJSON(exported))).toEqual(e);
  expect(materializationV1(parseJSON(exported), lockBytes)).toEqual(lock);
  expect(e.installed).toBeNull(); expect(e.running).toBeNull();
  if (split) expect(e.manifest!.roles.filter(r => r.kind === 'state')).toHaveLength(2);
});

test('historical PR01b envelope and lock retain exact reader meaning without promotion', () => {
  expect(validate('connectome.deployment/v1', legacy)).toEqual(legacy);
  expect(materializationV1(legacy, lockBytes)).toEqual(readLockfile(historical)!);
  expect(legacy.manifest).toBeUndefined();
  expect(() => exportManifest(legacy, lockBytes)).toThrow('E_PROOF_INCOMPLETE');
  // Historical unpinned materializations are still readable, not exportable.
  const old = structuredClone(lock); delete old.connectomeHost.commit;
  const bytes = canonical(old);
  expect(materializationV1({ ...legacy, materialized: { ...legacy.materialized, lockDigest: hash(bytes) } }, bytes)).toEqual(old);
  expect(() => manifest(bindings(), bytes)).toThrow('E_PIN_INCOMPLETE');
});

test('unknown envelope/record schema and duplicate JSON keys reject', () => {
  expect(() => exportManifest({ ...manifest(), schema: 'connectome.deployment/v2' }, lockBytes)).toThrow('E_SCHEMA');
  expect(() => validate('connectome.unknown/v1' as 'connectome.deployment/v1', legacy)).toThrow('E_SCHEMA');
  expect(() => parseJSON('{"schema":1,"schema":2}')).toThrow('E_SCHEMA');
});
for (const kind of ['config', 'runtime', 'state', 'workspace', 'credentials']) test(`missing ${kind} role rejects`, () => {
  const b = bindings(); b.roles = b.roles.filter(r => r.kind !== kind);
  expect(() => manifest(b)).toThrow('E_SCHEMA');
});

test('full commit pins required for host and every component, never PR heads', () => {
  for (const commit of [undefined, 'main', 'a'.repeat(7)]) {
    const l = { ...lock, connectomeHost: { ...lock.connectomeHost } };
    if (commit === undefined) delete l.connectomeHost.commit; else l.connectomeHost.commit = commit;
    expect(() => manifest(bindings(), canonical(l))).toThrow('E_PIN_INCOMPLETE');
  }
  const component = { key: 'extension', role: 'extension', url: 'https://example.invalid/ext', ref: 'main', path: '/srv/fixture/runtime/ext', install: 'copy' };
  expect(() => manifest(bindings(), canonical({ ...lock, components: [component] }))).toThrow('E_PIN_INCOMPLETE');
  expect(() => manifest(bindings(), canonical({ ...lock, connectomeHost: { ...lock.connectomeHost, ref: 'refs/pull/1/head' } }))).toThrow('E_PIN_INCOMPLETE');
  expect(() => manifest(bindings(), canonical({ ...lock, connectomeHost: { ...lock.connectomeHost, url: 'https://user:private@example.invalid/host' } }))).toThrow('E_SCOPE');
});

test('every component and local extension needs a runtime artifact binding', () => {
  const l = { ...lock, localExtensions: [{ name: 'local', hostDir: '/src/local', path: '/srv/fixture/runtime/local' }] };
  expect(() => manifest(bindings(), canonical(l))).toThrow('E_PROOF_INCOMPLETE');
  const b = bindings(); b.artifacts.push({ name: 'local', role: 'runtime', path: 'local', digest });
  expect(materializationV1(manifest(b, canonical(l)), canonical(l))).toEqual(l);
});

test('same code with changed config revision or config bytes has distinct deployment revision', () => {
  const e = manifest(); const b = bindings(); b.configRevision = 'd'.repeat(40);
  expect(manifest(b).manifest!.revision).not.toBe(e.manifest!.revision);
  const changed = extendEnvelope({ ...legacy, desired: { ...legacy.desired, configDigest: hash('changed nonsecret configuration') } }, lockBytes, bindings());
  expect(changed.manifest!.revision).not.toBe(e.manifest!.revision);
  expect(manifest().manifest!.revision).toBe(e.manifest!.revision);
  expect(changed.agent).toEqual(e.agent);
});

test('lock bytes and all declared bindings are integrity-bound', () => {
  const e = manifest();
  expect(() => exportManifest(e, lockBytes + '\n')).toThrow('E_DIGEST');
  e.manifest!.roles[0]!.owner.uid++;
  expect(() => exportManifest(e, lockBytes)).toThrow('E_DIGEST');
  expect(() => manifest({ ...bindings(), configRevision: 'main' })).toThrow('E_SCHEMA');
});

test('strict names, references, owner identity and paths reject malformed bindings', () => {
  const mutations: Array<(b: Omit<Manifest, 'revision'>) => void> = [
    b => { b.roles.push(b.roles[0]!); }, b => { b.profiles.push('default'); },
    b => { b.roles[0]!.owner.uid = -1; }, b => { b.roles[0]!.path = '/srv/../etc'; },
    b => { b.providers[0]!.destination = '../auth'; }, b => { b.providers[0]!.role = 'state'; },
    b => { b.providers[0]!.consumer = 'unknown'; }, b => { b.units[0]!.profile = 'unknown'; },
    b => { b.units[0]!.artifacts = ['missing']; }, b => { b.units[0]!.after = ['unknown.service']; },
    b => { b.artifacts[0]!.role = 'state'; }, b => { b.artifacts[0]!.role = 'credentials'; },
  ];
  for (const mutate of mutations) { const b = bindings(); mutate(b); expect(() => manifest(b)).toThrow(); }
});

test('provider references are names only; no values or private-value hashes in export', () => {
  const output = exportManifest(manifest(), lockBytes);
  expect(output).not.toContain(secret); expect(output).not.toContain(hash(secret));
  for (const key of ['value', 'token', 'password', 'valueDigest']) {
    const b = bindings(); Object.assign(b.providers[0]!, { [key]: secret });
    expect(() => manifest(b)).toThrow('E_SCHEMA');
  }
  const e = manifest(); Object.assign(e, { observed: observation(e) });
  expect(() => exportManifest(e, lockBytes)).toThrow('E_SCHEMA');
});

test('artifact hashes cannot cover private roles through nested path aliases', () => {
  for (const privateKind of ['state', 'workspace', 'credentials']) {
    const b = bindings(); b.roles.find(r => r.kind === privateKind)!.path = '/srv/fixture/runtime/app/private';
    expect(() => manifest(b)).toThrow('E_SCOPE');
  }
  const b = bindings(); b.providers.push({ ...b.providers[0]!, name: 'another-provider' });
  expect(() => manifest(b)).toThrow('E_PATH');
});

test('observed running is separate and incomplete transactions can never report running', () => {
  const e = manifest(); const o = observation(e);
  expect(readObservation(o, e)).toEqual(o);
  for (const outcome of ['pending', 'partial', 'uncertain', 'failed']) expect(() => readObservation({ ...o, transaction: { ...o.transaction, outcome } }, e)).toThrow('E_SCHEMA');
  expect(() => readObservation({ ...o, transaction: null }, e)).toThrow('E_SCHEMA');
  expect(() => readObservation({ ...o, units: [] }, e)).toThrow('E_SCHEMA');
  expect(() => readObservation({ ...o, units: ['other.service'] }, e)).toThrow('E_PROOF_INCOMPLETE');
  expect(() => readObservation({ ...o, revision: hash('other') }, e)).toThrow('E_DIGEST');
  expect(() => readObservation({ ...o, agent: { ...o.agent, id: o.agent.lineage } }, e)).toThrow('E_IDENTITY');
  expect(e.running).toBeNull(); expect(exportManifest(e, lockBytes)).not.toContain('observedAt');
  expect(() => validate('connectome.deployment/v1', { ...e, running: o })).toThrow('E_SCHEMA');
});

test('CLI exports/promotes only on request without changing inputs or reading private roles', () => {
  writeFileSync(join(dir, 'envelope.json'), canonical(legacy)); writeFileSync(join(dir, 'lock'), lockBytes);
  writeFileSync(join(dir, 'bindings.json'), canonical(bindings()));
  const args = ['export', 'envelope.json', '--lock', 'lock', '--bindings', 'bindings.json'];
  const before = readdirSync(dir).map(n => [n, readFileSync(join(dir, n), 'utf8')]);
  const r = cli(args);
  expect(r.status).toBe(0); expect(r.stderr).toBe(''); expect(parseJSON(r.stdout)).toEqual(manifest());
  expect(r.stdout + r.stderr).not.toContain(secret); expect(r.stdout + r.stderr).not.toContain(hash(secret));
  expect(readdirSync(dir).map(n => [n, readFileSync(join(dir, n), 'utf8')])).toEqual(before);
  writeFileSync(join(dir, 'full.json'), r.stdout);
  expect(cli(['export', 'full.json', '--lock', 'lock']).stdout).toBe(r.stdout);
});

test('CLI refusals emit no partial manifest, input values or unsanitized paths', () => {
  writeFileSync(join(dir, 'invalid.json'), secret);
  for (const args of [[], ['export', 'invalid.json', '--lock', 'invalid.json'], ['export', secret, '--lock', secret], ['export', '--unknown']]) {
    const r = cli(args); expect(r.status).not.toBe(0); expect(r.stdout).toBe('');
    expect(r.stderr).not.toContain(secret); expect(r.stderr).not.toContain(hash(secret));
  }
});

test('CLI secret scan covers private role files and rejected inline provider values', () => {
  const b = bindings();
  for (const kind of ['state', 'workspace', 'credentials']) {
    const role = b.roles.find(r => r.kind === kind)!; role.path = join(dir, kind);
    mkdirSync(role.path); writeFileSync(join(role.path, 'private'), secret, { mode: 0o600 });
  }
  writeFileSync(join(dir, 'envelope.json'), canonical(legacy)); writeFileSync(join(dir, 'lock'), lockBytes);
  writeFileSync(join(dir, 'bindings.json'), canonical(b));
  const args = ['export', 'envelope.json', '--lock', 'lock', '--bindings', 'bindings.json'];
  const r = cli(args); expect(r.status).toBe(0);
  expect(r.stdout + r.stderr).not.toContain(secret); expect(r.stdout + r.stderr).not.toContain(hash(secret));
  Object.assign(b.providers[0]!, { value: secret, valueDigest: hash(secret) });
  writeFileSync(join(dir, 'bindings.json'), canonical(b));
  const refused = cli(args); expect(refused.status).toBe(2); expect(refused.stdout).toBe('');
  expect(refused.stderr).not.toContain(secret); expect(refused.stderr).not.toContain(hash(secret));
  for (const kind of ['state', 'workspace', 'credentials']) expect(readFileSync(join(dir, kind, 'private'), 'utf8')).toBe(secret);
});

test('extension rejects an unversioned legacy shape or a supplied derived revision', () => {
  expect(() => extendEnvelope(lock, lockBytes, bindings())).toThrow('E_SCHEMA');
  expect(() => manifest({ ...bindings(), revision: digest } as Omit<Manifest, 'revision'>)).toThrow('E_SCHEMA');
  const e = manifest(); e.manifest!.roles[0]!.path = '/changed';
  expect(() => validate('connectome.deployment/v1', reseal(e))).not.toThrow();
});
