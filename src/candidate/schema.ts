/** PR01b wire contracts. Persisted records deliberately have no capabilities field. */
import { createHash } from 'node:crypto';
import { validateRecipe, type Recipe } from '../vendor/recipe.js';
import { assertCredentialFreeSourceUrl } from '../source-url.js';

export class CandidateError extends Error {
  constructor(public code: string, public exitCode = 2) { super(code); }
}
export function fail(code: string, exitCode = 2): never { throw new CandidateError(code, exitCode); }
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
export interface Agent { id: string; lineage: string }
export interface Declaration {
  schema: 'connectome.declaration/v1'; agent: Agent; entry: string;
  recipes: Record<string, Recipe>; host: { url: string; ref: string }; seedRequired: boolean; dataDir: 'data';
}
export interface Envelope {
  schema: 'connectome.deployment/v1'; agent: Agent;
  desired: { declaration: '.cook/declaration.json'; configDigest: string };
  materialized: { lock: 'connectome.lock'; lockVersion: 1; lockDigest: string };
  installed: null; running: null; lifecycle: 'held-candidate';
}
export interface Hold {
  schema: 'connectome.hold/v1'; agent: Agent; state: 'held'; scope: 'disposable-candidate';
  reason: 'candidate-preparation' | 'seed-pending' | 'ingest-incomplete'; createdAt: string;
}
export interface Intent {
  schema: 'connectome.ingest-intent/v1'; operationId: string; agent: Agent;
  configDigest: string; lockDigest: string; seedDigest: string; toolDigest: string;
  namespace: string; adapterId: string; dataDir: 'data'; startedAt: string;
}
export interface Result extends Omit<Intent, 'schema'> {
  schema: 'connectome.ingest-result/v1'; storeIdentity: string; qualificationId: string;
  finishedAt: string; outcome: 'complete' | 'partial' | 'uncertain';
}
export interface Marker extends Omit<Result, 'schema' | 'dataDir' | 'startedAt' | 'finishedAt'> {
  schema: 'connectome.seed-consumed/v1'; consumedAt: string; ingestResultDigest: string;
}
export type Check = 'envelope' | 'declaration' | 'materialization' | 'configuration' | 'requirements' | 'credentials' | 'seed' | 'handshakes' | 'deferred' | 'cli' | 'hold';
export interface Finding { code: string; severity: 'info' | 'warning' | 'error'; check: Check; subject: string; message: string; remedy: string }
export type Command = 'prepare' | 'hold' | 'hold-clear' | 'seed-check' | 'seed-complete' | 'verify';
export interface Findings {
  schema: 'connectome.findings/v1'; supported: string[]; command: Command;
  status: 'ok' | 'warning' | 'error'; held: boolean | null; activationAllowed: false; findings: Finding[];
}
export interface Records {
  'connectome.deployment/v1': Envelope; 'connectome.declaration/v1': Declaration;
  'connectome.hold/v1': Hold; 'connectome.ingest-intent/v1': Intent;
  'connectome.ingest-result/v1': Result; 'connectome.seed-consumed/v1': Marker;
  'connectome.findings/v1': Findings;
}
type Rule = (v: unknown) => boolean;
const text: Rule = v => typeof v === 'string' && v.length > 0;
const pattern = (p: RegExp): Rule => v => typeof v === 'string' && p.test(v);
const one = (...vs: unknown[]): Rule => v => vs.includes(v);
const time: Rule = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const object: Rule = v => !!v && typeof v === 'object' && !Array.isArray(v);
const closed = (shape: Record<string, Rule>): Rule => v => object(v) && Object.keys(v as object).length === Object.keys(shape).length && Object.entries(shape).every(([k, rule]) => Object.hasOwn(v as object, k) && rule((v as Record<string, unknown>)[k]));
const agent = closed({ id: pattern(UUID), lineage: pattern(UUID) });
const digest = pattern(DIGEST);
const outcome = one('complete', 'partial', 'uncertain');
const common = { operationId: pattern(UUID), agent, configDigest: digest, lockDigest: digest, seedDigest: digest, toolDigest: digest, namespace: text, adapterId: text };
const checks = ['envelope', 'declaration', 'materialization', 'configuration', 'requirements', 'credentials', 'seed', 'handshakes', 'deferred', 'cli', 'hold'];
export const CODES = ['E_USAGE', 'E_IO', 'E_HELD', 'E_CLEAR_UNSUPPORTED', 'E_SEED_EXISTS', 'E_HISTORY_EXISTS', 'E_INGEST_PENDING', 'E_INGEST_UNQUALIFIED', 'E_BUSY', 'E_JSON_UNSUPPORTED', 'E_SCHEMA', 'E_IDENTITY', 'E_DIGEST', 'E_PATH', 'E_MODE', 'E_SCOPE', 'E_ENV_FORMAT', 'E_CONFIG_DRIFT', 'E_PIN_INCOMPLETE', 'E_REQUIREMENT_MISSING', 'E_INGEST_MISSING', 'E_INGEST_INCOMPLETE', 'E_SEED_CONFLICT', 'E_HANDSHAKE_MISSING', 'E_PROOF_INCOMPLETE', 'W_CREDENTIAL_MISSING', 'W_LEGACY_UNMANAGED', 'I_CHECK_OK', 'I_HELD', 'I_MATERIALIZED', 'I_SEED_ELIGIBLE', 'I_SEED_COMPLETED', 'I_NOT_APPLICABLE'];
const finding = closed({ code: one(...CODES), severity: one('info', 'warning', 'error'), check: one(...checks), subject: text, message: text, remedy: text });
const recipes: Rule = v => {
  if (!object(v) || !Object.keys(v as object).length) return false;
  try {
    for (const [name, recipe] of Object.entries(v as object)) {
      if (name === '.' || name === '..' || /[/\\\0]/.test(name) || !name) return false;
      validateRecipe(recipe);
    }
    return true;
  } catch { return false; }
};
const rules: Record<keyof Records, Rule> = {
  'connectome.deployment/v1': closed({ schema: one('connectome.deployment/v1'), agent,
    desired: closed({ declaration: one('.cook/declaration.json'), configDigest: digest }),
    materialized: closed({ lock: one('connectome.lock'), lockVersion: one(1), lockDigest: digest }),
    installed: one(null), running: one(null), lifecycle: one('held-candidate') }),
  'connectome.declaration/v1': closed({ schema: one('connectome.declaration/v1'), agent, entry: text, recipes,
    host: closed({ url: text, ref: text }), seedRequired: one(true, false), dataDir: one('data') }),
  'connectome.hold/v1': closed({ schema: one('connectome.hold/v1'), agent, state: one('held'), scope: one('disposable-candidate'), reason: one('candidate-preparation', 'seed-pending', 'ingest-incomplete'), createdAt: time }),
  'connectome.ingest-intent/v1': closed({ schema: one('connectome.ingest-intent/v1'), ...common, dataDir: one('data'), startedAt: time }),
  'connectome.ingest-result/v1': closed({ schema: one('connectome.ingest-result/v1'), ...common, dataDir: one('data'), startedAt: time, finishedAt: time, storeIdentity: text, qualificationId: text, outcome }),
  'connectome.seed-consumed/v1': closed({ schema: one('connectome.seed-consumed/v1'), ...common, consumedAt: time, ingestResultDigest: digest, storeIdentity: text, qualificationId: text, outcome }),
  'connectome.findings/v1': closed({ schema: one('connectome.findings/v1'), supported: v => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string') && new Set(v).size === v.length && v.includes('connectome.findings/v1'), command: one('prepare', 'hold', 'hold-clear', 'seed-check', 'seed-complete', 'verify'), status: one('ok', 'warning', 'error'), held: one(true, false, null), activationAllowed: one(false), findings: v => Array.isArray(v) && v.every(finding) }),
};
export function validate<K extends keyof Records>(schema: K, value: unknown): Records[K] {
  if (!rules[schema](value)) fail('E_SCHEMA');
  if (schema === 'connectome.declaration/v1') {
    const d = value as Declaration;
    if (!Object.hasOwn(d.recipes, d.entry)) fail('E_SCHEMA');
    try { assertCredentialFreeSourceUrl(d.host.url); } catch { fail('E_SCHEMA'); }
  }
  if (schema === 'connectome.ingest-result/v1') {
    const r = value as Result;
    if (r.finishedAt < r.startedAt) fail('E_SCHEMA');
  }
  if (schema === 'connectome.findings/v1' && (value as Findings).status !== status((value as Findings).findings)) fail('E_SCHEMA');
  return value as Records[K];
}

/** Small strict JSON decoder: duplicate keys (including escaped aliases) must
 * not be erased by JSON.parse before validation/digesting. No eval/reviver. */
export function parseJSON(input: string): unknown {
  let i = 0;
  const ws = () => { while (/^[\t\n\r ]$/.test(input[i] ?? '')) i++; };
  const string = (): string => {
    const start = i++;
    while (i < input.length) {
      const c = input[i++];
      if (c === '\\') i++;
      else if (c === '"') return JSON.parse(input.slice(start, i)) as string;
    }
    return fail('E_SCHEMA');
  };
  const value = (): unknown => {
    ws(); const c = input[i];
    if (c === '"') return string();
    if (c === '{') {
      i++; ws(); const out: Record<string, unknown> = Object.create(null);
      if (input[i] === '}') { i++; return out; }
      while (true) {
        ws(); if (input[i] !== '"') fail('E_SCHEMA'); const k = string();
        if (Object.hasOwn(out, k)) fail('E_SCHEMA');
        ws(); if (input[i++] !== ':') fail('E_SCHEMA'); out[k] = value(); ws();
        const end = input[i++]; if (end === '}') return out; if (end !== ',') fail('E_SCHEMA');
      }
    }
    if (c === '[') {
      i++; ws(); const out: unknown[] = [];
      if (input[i] === ']') { i++; return out; }
      while (true) { out.push(value()); ws(); const end = input[i++]; if (end === ']') return out; if (end !== ',') fail('E_SCHEMA'); }
    }
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(input.slice(i));
    if (!m) fail('E_SCHEMA'); i += m[0].length;
    const v: unknown = JSON.parse(m[0]); if (typeof v === 'number' && !Number.isFinite(v)) fail('E_SCHEMA'); return v;
  };
  try { const v = value(); ws(); if (i !== input.length) fail('E_SCHEMA'); return v; } catch { return fail('E_SCHEMA'); }
}
export function canonical(v: unknown): string {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object' && v) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}';
  return fail('E_SCHEMA');
}
export const hash = (bytes: string | Buffer): string => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
export function status(findings: Finding[]): Findings['status'] { return findings.some(f => f.severity === 'error') ? 'error' : findings.some(f => f.severity === 'warning') ? 'warning' : 'ok'; }
export function report(command: Command, held: boolean | null, findings: Finding[]): Findings {
  findings.sort((a, b) => { const x = `${a.check}\0${a.subject}\0${a.code}`, y = `${b.check}\0${b.subject}\0${b.code}`; return x < y ? -1 : x > y ? 1 : 0; });
  return { schema: 'connectome.findings/v1', supported: ['connectome.findings/v1'], command, status: status(findings), held, activationAllowed: false, findings };
}
export function issue(code: string, check: Check, subject = '.', message = 'Candidate check failed.', remedy = 'Inspect the disposable candidate; do not activate.'): Finding {
  return { code, check, subject, severity: code.startsWith('I_') ? 'info' : code.startsWith('W_') ? 'warning' : 'error', message, remedy };
}
