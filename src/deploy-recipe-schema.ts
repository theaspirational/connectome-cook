/** Closed, typed deploy adapter schema. Do not delegate admission to the
 * compatibility-oriented legacy recipe validator. Runtime-defined selector
 * strings remain strings; structural enums and numeric domains are explicit. */
import { assertCredentialFreeSourceUrl } from './source-url.js';
type Rule = (value: unknown) => boolean;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const string: Rule = v => typeof v === 'string';
const text: Rule = v => typeof v === 'string' && v.length > 0;
const bool: Rule = v => typeof v === 'boolean';
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
const policy = object({
  alpha: ratio, budgetLowRatio: ratio, budgetHighRatio: ratio,
  budgetUnderLambda: number(), budgetOverLambda: number(), cacheLambda: number(),
  cacheScale: number(Number.MIN_VALUE), cacheReadPrice: number(), cacheWritePrice: number(),
  continuityLambda: number(), continuityScale: number(Number.MIN_VALUE),
  continuityRecencyHalfLifeTokens: integer(1), continuityRecencyFloor: ratio,
  continuityStableHalfLife: integer(1), continuityStableFloor: ratio,
});
const strategy = object({
  type: one('autobiographical', 'passthrough', 'frontdesk'),
  headWindowTokens: integer(), recentWindowTokens: integer(), compressionModel: text,
  maxMessageTokens: integer(1), adaptiveResolution: bool, foldingStrategy: text,
  targetChunkTokens: integer(1), compressionSlackRatio: ratio, mergeThreshold: integer(1),
  enforceBudget: bool, overBudgetGraceRatio: ratio, maxSpeculativeL1s: integer(),
  summaryParticipant: text, compressionRecallBudgetTokens: integer(),
  compressionToolProseFallback: object({ intoTool: text, fromTools: array(text), minChars: integer() }),
  kvUnified: object({ policy, tokenBucketSize: integer(1), continuityBucketSize: integer(1),
    fidelityBucketSize: integer(1), labelCeiling: integer(1), adoptEpsilon: number(),
    treeifyNonContiguousSummaries: bool, preserveGapBearingSummaries: bool, hysteresisCertificate: bool }),
}, ['type']);
const agent = object({
  name: text, provider: text, model: text, systemPrompt: text,
  maxTokens: integer(1), strategy, formatter: text, contextBudgetTokens: integer(1),
  thinking: object({ enabled: bool, type: text, display: text, budgetTokens: integer() }),
  cacheKeepalive: object({ enabled: bool, refreshAfterMinutes: number(Number.MIN_VALUE), maxIdleHours: number() }),
  maxStreamTokens: integer(1), proseRouting: text, cacheTtl: text,
}, ['systemPrompt']);
const server = object({
  command: text, args: strings, env: dictionary(string), url: sourceURL,
  transport: one('stdio', 'websocket'), token: text, toolPrefix: string,
  enabledFeatureSets: strings, disabledFeatureSets: strings, enabledTools: strings,
  disabledTools: strings, reconnect: bool, reconnectIntervalMs: integer(),
  channelSubscription: either(one('auto', 'manual'), array(text)), source, sourceMeta: source,
  inheritEnv: bool, requestTimeoutMs: integer(1), enabledCapabilities: strings, disabledCapabilities: strings,
});
const mount = object({
  name: text, path: text, mode: one('read-write', 'read-only'),
  watch: one('always', 'on-agent-action', 'never'), ignore: strings,
  wakeOnChange: either(bool, array(one('created', 'modified', 'deleted'))), autoMaterialize: bool,
}, ['name', 'path']);
const modules = object({
  subagents: either(bool, object({ defaultModel: text, defaultMaxTokens: integer(1) })),
  lessons: bool, retrieval: either(bool, object({ model: text, maxInjected: integer() })),
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
  if (!recipe(value)) throw new Error('E_DEPLOY_SCHEMA');
}
