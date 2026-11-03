import { validateDeployRecipe } from './deploy-recipe-schema.js';
/** Deploy declarations are JSON with optional full-line YAML comments, as in
 * connectome-agents. Never evaluate templates, open credential files or fetch. */
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, hash, parseJSON, UUID } from './candidate/schema.js';
import { exists, noLinks } from './candidate/io.js';
import { assertCredentialFreeSourceUrl } from './source-url.js';
import { validateRecipe, type Recipe } from './vendor/recipe.js';
import { parseHostDependencies } from './host-dependency.js';
import { validateUserUnit } from './host-unit.js';
import { hostLayout, type HostLayout } from './host-layout.js';
import { credentialBindings, type CredentialBindings } from './host-credentials.js';

export function refuse(code = 'E_DEPLOY_SCHEMA'): never { throw new Error(code); }
type Obj = Record<string, unknown>;
export function object(v: unknown): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return refuse();
  return v as Obj;
}
function closed(v: unknown, keys: string[]): Obj {
  const o = object(v);
  if (Object.keys(o).some(k => !keys.includes(k))) refuse();
  return o;
}
function text(v: unknown): string {
  if (typeof v !== 'string' || !v || /[\x00-\x1f\x7f]/.test(v)) return refuse();
  return v;
}
function strings(v: unknown): void { for (const s of Object.values(object(v))) text(s); }
function path(v: unknown): string {
  const p = text(v);
  if (!p.startsWith('/') || p.includes('\\') || p.split('/').slice(1).some(x => !x || x === '.' || x === '..')) refuse();
  return p;
}
/** Deliberately conservative accidental-secret guard, not a secret detector
 * for arbitrary prose. Errors never contain supplied keys, values or paths. */
export function secretFree(v: unknown, key = '', pin = false): void {
  const sensitive = /(?:password|secret|token|api[_-]?key|authorization)$/i.test(key);
  if (typeof v === 'string') {
    if (/(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-[A-Za-z0-9]|glpat-|-----BEGIN .*PRIVATE KEY|\b\d{8,}:[A-Za-z0-9_-]{25,}|eyJ[A-Za-z0-9_-]+\.eyJ)/.test(v)) refuse('E_DEPLOY_SECRET');
    const reference = /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(v) || v.startsWith('/');
    if (sensitive && !reference) refuse('E_DEPLOY_SECRET');
    if (!pin && !reference && /^[A-Za-z0-9_+/=-]{40,}$/.test(v)) refuse('E_DEPLOY_SECRET');
  } else if (Array.isArray(v)) v.forEach(x => secretFree(x, key, pin));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) secretFree(x, sensitive ? key : k, pin);
  else if (sensitive) refuse('E_DEPLOY_SECRET');
}
function read(path: string): unknown {
  noLinks(path);
  if (!lstatSync(path).isFile() || lstatSync(path).size > 2 * 1024 * 1024) refuse();
  return parseJSON(readFileSync(path, 'utf8').split('\n').filter(l => !/^\s*#/.test(l)).join('\n'));
}
const pinKeys = ['runtime', 'slack', 'telegram', 'github_mcpl', 'terminal_sessions'];
function pins(v: unknown): Record<string, string> {
  const p = closed(v, pinKeys); secretFree(p, '', true);
  for (const val of Object.values(p)) if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text(val))) refuse();
  return p as Record<string, string>;
}
const serviceKeys = ['Type','User','Group','WorkingDirectory','UMask','Restart','RestartSec','LimitCORE','RuntimeDirectory','RuntimeDirectoryMode','NoNewPrivileges','PrivateTmp','ProtectSystem','ReadWritePaths','MemoryMax','TasksMax','CPUQuota','TimeoutStopSec','KillMode','StandardOutput','StandardError'];
export interface AgentConfig {
  host: string; user: string; hold: boolean; layout: string;
  paths: Record<string, string>; release: string;
  units: Record<string, { name: string; exec_start: string[]; unit: Record<string,string>; service: Record<string,string>; environment: Record<string,string>; install: Record<string,string>; exec_start_pre?: string }>;
  credentials: Array<{ name: string; source: string; deliver: string; consumer: string; destination?: string }>;
  seed_settings: null; versions?: Record<string, string>;
}
function agent(v: unknown): AgentConfig {
  const a = closed(v, ['host','user','hold','layout','paths','release','units','credentials','seed_settings','versions']);
  const { versions, ...nonPins } = a; secretFree(nonPins);
  for (const k of ['host','user','layout','release']) text(a[k]);
  if (typeof a.hold !== 'boolean' || a.seed_settings !== null) refuse();
  const paths = closed(a.paths, ['state_root','releases_dir','runtimes_dir','credentials_dir','connectors_root']);
  for (const p of Object.values(paths)) path(p);
  if (!Object.keys(object(a.units)).length) refuse();
  for (const [name, value] of Object.entries(object(a.units))) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) refuse();
    const u = closed(value, ['name','exec_start','unit','service','exec_start_pre','environment','install']);
    validateUserUnit(text(u.name));
    if (!Array.isArray(u.exec_start) || !u.exec_start.length) return refuse();
    u.exec_start.forEach(text);
    strings(closed(u.unit, ['After','Wants','ConditionPathExists','StartLimitIntervalSec','StartLimitBurst']));
    strings(closed(u.service, serviceKeys));
    strings(closed(u.install, ['WantedBy'])); strings(u.environment);
    if (u.exec_start_pre !== undefined) text(u.exec_start_pre);
  }
  if (!Array.isArray(a.credentials)) return refuse();
  const names = new Set<string>();
  for (const value of a.credentials) {
    const c = closed(value, ['name','source','deliver','consumer','destination']);
    const name = text(c.name);
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || names.has(name)) refuse(); names.add(name);
    path(c.source); text(c.consumer);
    if (!['file','systemd-credential','systemd-credential+copy-0600'].includes(text(c.deliver))) refuse();
    if (c.destination !== undefined) path(c.destination);
  }
  const unitNames=Object.values(object(a.units)).map(u=>object(u).name);
  if(new Set(unitNames).size!==unitNames.length)refuse();
  if (versions !== undefined) pins(versions);
  return a as unknown as AgentConfig;
}
export interface HostConfig {
  chRepo?: string; chRef?: string; bunPath?: string; nodePath?: string;
  hostDependencies?: string[]; userUnit?: string; layout?: HostLayout;
  credentialBindings?: CredentialBindings; agentId?: string; lineage?: string;
}
function host(v: unknown): HostConfig {
  const h = closed(v, ['chRepo','chRef','bunPath','nodePath','hostDependencies','userUnit','layout','credentialBindings','agentId','lineage']);
  // Commit/hash/identity positions are typed below, not arbitrary secret slots.
  const {credentialBindings: namedBindings,...otherHost}=h;
  secretFree(otherHost, '', true);
  if(namedBindings!==undefined){
    const c=object(namedBindings);
    secretFree([c.schema,c.root,...Object.keys(object(c.files)),...Object.values(object(c.files)),...Object.values(object(c.consumers)).flatMap(m=>Object.values(object(m)))]);
  }
  if (h.chRepo !== undefined) assertCredentialFreeSourceUrl(text(h.chRepo));
  if (h.chRef !== undefined && !/^[0-9a-f]{40}$/.test(text(h.chRef))) refuse();
  for (const k of ['bunPath','nodePath']) if (h[k] !== undefined) path(h[k]);
  for (const k of ['agentId','lineage']) if (h[k] !== undefined && !UUID.test(text(h[k]))) refuse();
  if (h.userUnit !== undefined) validateUserUnit(text(h.userUnit));
  if (h.hostDependencies !== undefined) {
    if (!Array.isArray(h.hostDependencies)) refuse();
    parseHostDependencies(h.hostDependencies);
  }
  if (h.layout !== undefined) {
    const layout = JSON.parse(JSON.stringify(h.layout).replaceAll('{build}', '/__cook_build__'));
    hostLayout(layout, text(object(layout).runtime));
  }
  if (h.credentialBindings !== undefined) credentialBindings(JSON.parse(JSON.stringify(h.credentialBindings).replaceAll('{build}', '/__cook_build__')));
  return h as HostConfig;
}
export interface DeployPlan {
  schema: 'connectome.deploy-plan/v1'; agent: string;
  effectivePins: Record<string, { value: string; source: 'base' | 'override' }>;
  recipeDigest: string; configuration: AgentConfig; host: HostConfig; missing: string[];
}
/** Explicit {pin} placeholders bind build options/recipes to effective pins.
 * Existing concrete labels are preserved; no guessing or substring rewrites. */
function expand(v: unknown, effective: Record<string,string>): unknown {
  if (typeof v === 'string') return v.replace(/\{(runtime|slack|telegram|github_mcpl|terminal_sessions)\}/g, (_, k: string) => effective[k] ?? refuse());
  if (Array.isArray(v)) return v.map(x => expand(x, effective));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x]) => [k,expand(x,effective)]));
  return v;
}
export function readDeployRepo(repo: string, slug: string): { plan: DeployPlan; recipe: Recipe } {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) refuse();
  const base = pins(read(join(repo, 'versions.yml')));
  if (!Object.keys(base).length) refuse();
  const dir = join(repo, 'agents', slug), a = agent(read(join(dir, 'agent.yml')));
  const overrides = a.versions ?? {};
  if (Object.keys(overrides).some(k => !Object.hasOwn(base,k))) refuse();
  const effective = { ...base, ...overrides };
  const rawRecipe = read(join(dir, 'recipe.json')); secretFree(rawRecipe); validateDeployRecipe(rawRecipe);
  const recipe = validateRecipe(expand(rawRecipe, effective));
  const rawHost=exists(join(dir,'host.yml'))?read(join(dir,'host.yml')):{};
  const h = host(expand(rawHost,effective));
  if(h.userUnit&&!Object.values(a.units).some(u=>u.name===h.userUnit))refuse('E_DEPLOY_BINDINGS');
  const missing = ['chRepo','chRef','bunPath','nodePath','hostDependencies','agentId','lineage'].filter(k => !Object.hasOwn(h,k));
  for(const key of Object.keys(overrides))if(!JSON.stringify([rawRecipe,rawHost]).includes('{'+key+'}'))missing.push('versions.'+key+'.binding');
  const plan: DeployPlan = { schema:'connectome.deploy-plan/v1', agent:slug,
    effectivePins: Object.fromEntries(Object.keys(base).sort().map(k => [k,{value:effective[k]!,source:Object.hasOwn(overrides,k)?'override':'base'}])),
    recipeDigest:hash(canonical(recipe)), configuration:a, host:h, missing };
  return { plan, recipe };
}
