/** Closed, typed deploy adapter schema. Do not delegate admission to the
 * compatibility-oriented legacy recipe validator. Runtime-defined selector
 * strings remain strings; structural enums and numeric domains are explicit. */
import { assertCredentialFreeSourceUrl } from './source-url.js';
type Rule = (value: unknown) => boolean;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const string: Rule = v => typeof v === 'string';
const text: Rule = v => typeof v === 'string' && v.length > 0;
const bool: Rule = v => typeof v === 'boolean';
// Host recipe.ts at 925e4f70: unbounded slots are type-only; the JSON
// decoder separately rejects non-finite wire numbers. Do not infer integer or
// ratio domains from names. See the FIX2 domain audit and boundary tests.
const numeric: Rule = v => typeof v === 'number';
const number = (min = 0, max = Number.MAX_VALUE): Rule => v => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const integer = (min = 0): Rule => v => Number.isSafeInteger(v) && (v as number) >= min;
const ratio = number(0, 1);
const one = (...values: string[]): Rule => v => typeof v === 'string' && values.includes(v);
const either = (...rules: Rule[]): Rule => v => rules.some(rule => rule(v));
const array = (rule: Rule): Rule => v => Array.isArray(v) && v.every(rule);
const strings = array(string);
const dictionary = (rule: Rule): Rule => v => record(v) && Object.keys(v).every(k => k.length > 0) && Object.values(v).every(rule);
const object = (shape: Record<string, Rule>, required: string[] = []): Rule => v => record(v) &&
  required.every(k => Object.hasOwn(v, k)) && Object.entries(v).every(([k, value]) => Object.hasOwn(shape, k) && shape[k]!(value));
const sourceURL: Rule = v => {
  if (!text(v)) return false;
  try { assertCredentialFreeSourceUrl(v as string); return true; } catch { return false; }
};
const source = either(
  object({ npm: text }, ['npm']),
  object({ url: sourceURL, ref: text, install: either(one('npm', 'pip-editable'),
    object({ run: text, runtime: one('node', 'python3', 'custom', 'bun') }, ['run', 'runtime'])),
    authSecret: text, sslBypass: bool, inContainer: object({ path: text }, ['path']), systemPackages: array(text) }, ['url']),
);
// Cook-only provenance (vendor/recipe.ts:113–124), ignored by the host:
// retain closed value types, but do not impose runtime install enum bounds.
const sourceMeta = either(object({ npm: text }, ['npm']), object({
  url: sourceURL, ref: text, install: either(string, object({ run: text, runtime: string }, ['run','runtime'])),
  authSecret: text, sslBypass: bool, inContainer: object({ path: text }, ['path']), systemPackages: array(text),
}, ['url']));
const policy = object({
  alpha: number(), budgetLowRatio: ratio, budgetHighRatio: ratio,
  budgetUnderLambda: number(), budgetOverLambda: number(), cacheLambda: number(),
  cacheScale: number(Number.MIN_VALUE), cacheReadPrice: number(), cacheWritePrice: number(),
  continuityLambda: number(), continuityScale: number(Number.MIN_VALUE),
  continuityRecencyHalfLifeTokens: number(Number.MIN_VALUE), continuityRecencyFloor: ratio,
  continuityStableHalfLife: number(Number.MIN_VALUE), continuityStableFloor: ratio,
});
const strategy = object({
  type: one('autobiographical', 'passthrough', 'frontdesk'),
  headWindowTokens: numeric, recentWindowTokens: numeric, compressionModel: text,
  maxMessageTokens: numeric, adaptiveResolution: bool, foldingStrategy: one('flat-profile', 'oldest-first', 'kv-stable', 'kv-unified'),
  targetChunkTokens: numeric, compressionSlackRatio: numeric, mergeThreshold: numeric,
  enforceBudget: bool, overBudgetGraceRatio: numeric, maxSpeculativeL1s: numeric,
  summaryParticipant: text, compressionRecallBudgetTokens: integer(1),
  compressionToolProseFallback: object({ intoTool: text, fromTools: array(text), minChars: integer() }),
  kvUnified: object({ policy, tokenBucketSize: integer(1), continuityBucketSize: integer(1),
    fidelityBucketSize: integer(1), labelCeiling: integer(1), adoptEpsilon: number(),
    treeifyNonContiguousSummaries: bool, preserveGapBearingSummaries: bool, hysteresisCertificate: bool }),
}); // Host defaults omitted strategy.type to autobiographical (1838).
const agent = object({
  name: text, provider: text, model: text, systemPrompt: text,
  maxTokens: numeric, strategy, formatter: text, contextBudgetTokens: numeric,
  thinking: object({ enabled: bool, type: one('enabled', 'adaptive'), display: one('summarized', 'omitted'), budgetTokens: number(Number.MIN_VALUE) }),
  cacheKeepalive: object({ enabled: bool, refreshAfterMinutes: number(Number.MIN_VALUE), maxIdleHours: number(Number.MIN_VALUE) }),
  maxStreamTokens: number(Number.MIN_VALUE), proseRouting: one('locus', 'explicit', 'hybrid', 'disabled'), cacheTtl: one('5m', '1h'),
}, ['systemPrompt']);
const server = object({
  command: text, args: strings, env: dictionary(string), url: sourceURL,
  transport: one('stdio', 'websocket'), token: text, toolPrefix: string,
  enabledFeatureSets: strings, disabledFeatureSets: strings, enabledTools: strings,
  disabledTools: strings, reconnect: bool, reconnectIntervalMs: numeric,
  channelSubscription: either(one('auto', 'manual'), strings), source, sourceMeta,
  inheritEnv: bool, requestTimeoutMs: number(), enabledCapabilities: strings, disabledCapabilities: strings,
});
const mount = object({
  name: text, path: text, mode: one('read-write', 'read-only'),
  watch: one('always', 'on-agent-action', 'never'), ignore: strings,
  wakeOnChange: either(bool, array(one('created', 'modified', 'deleted'))), autoMaterialize: bool,
}, ['name', 'path']);
const modules = object({
  subagents: either(bool, object({ defaultModel: text, defaultMaxTokens: numeric })),
  lessons: bool, retrieval: either(bool, object({ model: text, maxInjected: numeric })),
  wake: bool, workspace: either(bool, object({ mounts: array(mount), configMount: bool }, ['mounts'])),
  activity: either(bool, object({ channels: strings })), fleet: bool, webui: bool,
  mcplAdmin: bool, identity: bool, history: bool, notices: bool, instructions: bool,
  subscriptionGc: bool, channelMode: bool,
});
const recipe = object({
  name: text, description: string, version: text, agent, codeExecution: object({ enabled: bool }),
  mcpServers: dictionary(server), modules, sessionNaming: object({ examples: strings }),
}, ['name', 'agent']);
export function validateDeployRecipe(value: unknown): void {
  const fail = (): never => { throw new Error('E_DEPLOY_SCHEMA'); };
  if (!recipe(value)) fail();
  const r = value as { agent: { maxTokens?: number; cacheTtl?: string;
    thinking?: { enabled?: boolean; budgetTokens?: number };
    cacheKeepalive?: { refreshAfterMinutes?: number };
    strategy?: { kvUnified?: { policy?: { budgetLowRatio?: number; budgetHighRatio?: number } } } } };
  const a=r.agent, thinking=a.thinking, refresh=a.cacheKeepalive?.refreshAfterMinutes;
  // Host recipe.ts:2465–2466, 2517–2518, 1891–1894.
  if (refresh!==undefined && refresh >= (a.cacheTtl==='5m'?5:60)) fail();
  if (thinking?.enabled===true && thinking.budgetTokens!==undefined && a.maxTokens!==undefined && thinking.budgetTokens>=a.maxTokens) fail();
  const policy=a.strategy?.kvUnified?.policy;
  if (policy?.budgetLowRatio!==undefined && policy.budgetHighRatio!==undefined && policy.budgetLowRatio>policy.budgetHighRatio) fail();
}
