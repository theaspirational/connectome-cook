import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Independent fixture enumerates every admitted field, including each union
// branch. Each slot is mutated through the public CLI, not the schema helper.
const git = { url:'https://example.invalid/source', ref:'{runtime}', install:{run:'/bin/true',runtime:'custom'}, authSecret:'${BUILD_AUTH}', sslBypass:false, inContainer:{path:'/app/fixture'}, systemPackages:['fixture'] };
const full = {
  name:'Fixture',description:'Fixture',version:'1.0.0',
  agent:{name:'Fixture',provider:'anthropic',model:'fixture',systemPrompt:'Fixture',maxTokens:100,
    formatter:'native',contextBudgetTokens:100,thinking:{enabled:true,type:'adaptive',display:'summarized',budgetTokens:1},
    cacheKeepalive:{enabled:true,refreshAfterMinutes:1,maxIdleHours:1},maxStreamTokens:100,proseRouting:'disabled',cacheTtl:'1h',
    strategy:{type:'autobiographical',headWindowTokens:0,recentWindowTokens:100,compressionModel:'fixture',maxMessageTokens:100,
      adaptiveResolution:true,foldingStrategy:'kv-unified',targetChunkTokens:10,compressionSlackRatio:0.1,mergeThreshold:2,
      enforceBudget:true,overBudgetGraceRatio:0.2,maxSpeculativeL1s:0,summaryParticipant:'Fixture',compressionRecallBudgetTokens:100,
      compressionToolProseFallback:{intoTool:'journal',fromTools:['think'],minChars:0},
      kvUnified:{policy:{alpha:0.5,budgetLowRatio:0.5,budgetHighRatio:0.8,budgetUnderLambda:0,budgetOverLambda:0,cacheLambda:0,
        cacheScale:1,cacheReadPrice:0,cacheWritePrice:0,continuityLambda:0,continuityScale:1,continuityRecencyHalfLifeTokens:1,
        continuityRecencyFloor:0.1,continuityStableHalfLife:1,continuityStableFloor:0.1},tokenBucketSize:1,continuityBucketSize:1,
        fidelityBucketSize:1,labelCeiling:1,adoptEpsilon:0,treeifyNonContiguousSummaries:false,preserveGapBearingSummaries:false,hysteresisCertificate:true}}},
  codeExecution:{enabled:true},sessionNaming:{examples:['Fixture']},
  mcpServers:{local:{command:'node',args:['fixture.js'],env:{FIXTURE:'text'},toolPrefix:'local',enabledFeatureSets:['a'],disabledFeatureSets:['b'],
    enabledTools:['a'],disabledTools:['b'],reconnect:true,reconnectIntervalMs:0,channelSubscription:['channel'],source:git,sourceMeta:structuredClone(git),
    inheritEnv:false,requestTimeoutMs:1,enabledCapabilities:['tools'],disabledCapabilities:['channels'],transport:'stdio'},
    remote:{url:'wss://example.invalid/mcpl',transport:'websocket',token:'${TOKEN}',channelSubscription:'auto'},
    npm:{command:'node',source:{npm:'fixture@1.0.0'},sourceMeta:{npm:'fixture@1.0.0'}}},
  modules:{subagents:{defaultModel:'fixture',defaultMaxTokens:1},lessons:false,retrieval:{model:'fixture',maxInjected:0},wake:false,
    workspace:{configMount:false,mounts:[{name:'files',path:'/workspace',mode:'read-write',watch:'never',ignore:['*.tmp'],wakeOnChange:['created'],autoMaterialize:true}]},
    activity:{channels:['a']},fleet:false,webui:false,mcplAdmin:false,identity:false,history:true,notices:false,instructions:false,subscriptionGc:false,channelMode:false},
};
let root:string;
beforeAll(()=>{
  root=mkdtempSync(join(tmpdir(),'cook-schema-cli-'));mkdirSync(join(root,'agents/fixture'),{recursive:true});
  writeFileSync(join(root,'versions.yml'),JSON.stringify({runtime:'fixture'}));
  writeFileSync(join(root,'agents/fixture/agent.yml'),JSON.stringify({host:'fixture',user:'fixture',hold:false,layout:'legacy-support-agents',paths:{},release:'fixture',
    units:{main:{name:'fixture.service',exec_start:['/bin/false'],unit:{},service:{},environment:{},install:{}}},credentials:[],seed_settings:null}));
});
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function run(recipe:unknown) {
  writeFileSync(join(root,'agents/fixture/recipe.json'),JSON.stringify(recipe));
  return spawnSync(process.execPath,[resolve('bin/cook'),'deploy','plan','--repo',root,'--agent','fixture'],{encoding:'utf8'});
}
type Path = Array<string|number>;
function changed(path:Path,value:unknown):unknown {
  if(!path.length)return value;
  const copy=structuredClone(full);let parent:unknown=copy;
  for(const part of path.slice(0,-1))parent=(parent as Record<string|number,unknown>)[part];
  (parent as Record<string|number,unknown>)[path.at(-1)!]=value;return copy;
}
function refuses(recipe:unknown) {
  const r=run(recipe);expect(r.status).toBe(2);expect(r.stdout).toBe('');
  expect(r.stderr).toMatch(/^E_DEPLOY_(SCHEMA|SECRET|REFUSED): deploy refused\.\n$/);
  expect(r.stderr).not.toContain('unexpected');
}
const slots:Array<{path:Path,value:unknown}>=[];
function enumerate(v:unknown,path:Path=[]):void {
  slots.push({path,value:v});
  if(v&&typeof v==='object')for(const [key,value] of Object.entries(v))enumerate(value,[...path,Array.isArray(v)?Number(key):key]);
}
enumerate(full);
test('complete typed recipe fixture is admitted by real plan',()=>{const r=run(full);expect(r.status).toBe(0);expect(JSON.parse(r.stdout).recipeDigest).toMatch(/^sha256:/);});
for(const {path,value} of slots)test('CLI rejects wrong structure at '+(path.join('.')||'<root>'),()=>{
  refuses(changed(path,null));
  // Every scalar slot must also refuse containers with unknown nested keys.
  if(typeof value!=='object')refuses(changed(path,{unexpected:true}));
  else if(!Array.isArray(value))refuses(changed(path,{...(value as object),unexpected:true}));
});
// Audited against connectome-host origin/main 925e4f70758a8d6e738bc70f0f3c1eb773be0a27.
// Line references belong to that immutable src/recipe.ts, not the working copy.
type Domain = 'number'|'positive'|'nonnegative'|'ratio'|'safePositive'|'safeNonnegative'|'refresh';
const numericAudit: Array<[string,Domain,string]> = [
  ['agent.maxTokens','number','301 (no validator bound)'],
  ['agent.contextBudgetTokens','number','323 (no validator bound)'],
  ['agent.maxStreamTokens','positive','2381–2382'],
  ['agent.thinking.budgetTokens','positive','2503–2504; enabled cross-bound 2517–2518'],
  ['agent.cacheKeepalive.refreshAfterMinutes','refresh','2461–2468'],
  ['agent.cacheKeepalive.maxIdleHours','positive','2473–2474'],
  ['agent.strategy.headWindowTokens','number','31 (no validator bound)'],
  ['agent.strategy.recentWindowTokens','number','36 (no validator bound)'],
  ['agent.strategy.maxMessageTokens','number','48 (no validator bound)'],
  ['agent.strategy.targetChunkTokens','number','121 (no validator bound)'],
  ['agent.strategy.compressionSlackRatio','number','145 (no validator bound)'],
  ['agent.strategy.mergeThreshold','number','122 (no validator bound)'],
  ['agent.strategy.overBudgetGraceRatio','number','59 (no validator bound)'],
  ['agent.strategy.maxSpeculativeL1s','number','61 (no validator bound)'],
  ['agent.strategy.compressionRecallBudgetTokens','safePositive','2680–2687'],
  ['agent.strategy.compressionToolProseFallback.minChars','safeNonnegative','2664–2668'],
  ['agent.strategy.kvUnified.policy.alpha','nonnegative','1862–1881'],
  ['agent.strategy.kvUnified.policy.budgetLowRatio','ratio','1891–1894'],
  ['agent.strategy.kvUnified.policy.budgetHighRatio','ratio','1891–1894'],
  ['agent.strategy.kvUnified.policy.budgetUnderLambda','nonnegative','1862–1881'],
  ['agent.strategy.kvUnified.policy.budgetOverLambda','nonnegative','1862–1881'],
  ['agent.strategy.kvUnified.policy.cacheLambda','nonnegative','1862–1881'],
  ['agent.strategy.kvUnified.policy.cacheScale','positive','1862–1871,1883–1888'],
  ['agent.strategy.kvUnified.policy.cacheReadPrice','nonnegative','1862–1881'],
  ['agent.strategy.kvUnified.policy.cacheWritePrice','nonnegative','1862–1881'],
  ['agent.strategy.kvUnified.policy.continuityLambda','nonnegative','1862–1881'],
  ['agent.strategy.kvUnified.policy.continuityScale','positive','1862–1871,1883–1888'],
  ['agent.strategy.kvUnified.policy.continuityRecencyHalfLifeTokens','positive','1862–1871,1883–1888'],
  ['agent.strategy.kvUnified.policy.continuityRecencyFloor','ratio','1896–1899'],
  ['agent.strategy.kvUnified.policy.continuityStableHalfLife','positive','1862–1871,1883–1888'],
  ['agent.strategy.kvUnified.policy.continuityStableFloor','ratio','1896–1899'],
  ['agent.strategy.kvUnified.tokenBucketSize','safePositive','1909–1914'],
  ['agent.strategy.kvUnified.continuityBucketSize','safePositive','1909–1914'],
  ['agent.strategy.kvUnified.fidelityBucketSize','safePositive','1909–1914'],
  ['agent.strategy.kvUnified.labelCeiling','safePositive','1909–1914'],
  ['agent.strategy.kvUnified.adoptEpsilon','nonnegative','1917–1922'],
  ['mcpServers.local.reconnectIntervalMs','number','585–587 (no validator bound)'],
  ['mcpServers.local.requestTimeoutMs','nonnegative','2736–2738'],
  ['modules.subagents.defaultMaxTokens','number','934–936 (no validator bound)'],
  ['modules.retrieval.maxInjected','number','967–969 (no validator bound)'],
];
function below(value:number):number {
  const data=new DataView(new ArrayBuffer(8));data.setFloat64(0,value);
  data.setBigUint64(0,data.getBigUint64(0)-1n);return data.getFloat64(0);
}
function numericRecipe(slot:string,value:number) {
  const result=changed(slot.split('.'),value) as typeof full;
  // Isolate each domain from host's separate tuple constraints.
  result.agent.thinking.enabled=false;
  if(slot.endsWith('.budgetLowRatio'))result.agent.strategy.kvUnified.policy.budgetHighRatio=1;
  if(slot.endsWith('.budgetHighRatio'))result.agent.strategy.kvUnified.policy.budgetLowRatio=0;
  return result;
}
const valid:Record<Domain,number[]>={
  number:[-Number.MAX_VALUE,-0.5,0,0.5,Number.MAX_VALUE],
  positive:[Number.MIN_VALUE,0.5,Number.MAX_VALUE],
  nonnegative:[0,0.5,2,Number.MAX_VALUE],ratio:[0,0.5,1],
  safePositive:[1,Number.MAX_SAFE_INTEGER],safeNonnegative:[0,Number.MAX_SAFE_INTEGER],
  refresh:[Number.MIN_VALUE,0.5,below(60)],
};
const invalid:Record<Domain,number[]>={number:[],positive:[-1,0],nonnegative:[-1],ratio:[-1,1.1],
  safePositive:[-1,0,0.5,Number.MAX_SAFE_INTEGER+1],safeNonnegative:[-1,0.5,Number.MAX_SAFE_INTEGER+1],refresh:[-1,0,60]};
test('numeric audit covers every numeric fixture slot',()=>{
  expect(numericAudit.map(([p])=>p).sort()).toEqual(slots.filter(x=>typeof x.value==='number').map(x=>x.path.join('.')).sort());
});
for(const [slot,domain,line] of numericAudit)test(`CLI host domain ${slot} (${line})`,()=>{
  for(const value of valid[domain])expect(run(numericRecipe(slot,value)).status).toBe(0);
  for(const value of invalid[domain])refuses(numericRecipe(slot,value));
});
test('CLI accepts alpha > 1 and fractional half-lives together',()=>{
  const r=structuredClone(full);Object.assign(r.agent.strategy.kvUnified.policy,{alpha:2,continuityRecencyHalfLifeTokens:0.25,continuityStableHalfLife:0.5});
  expect(run(r).status).toBe(0);
});
test('CLI honors host relational bounds at representable endpoints',()=>{
  for(const [ttl,limit] of [['5m',5],['1h',60]] as const){
    const r=structuredClone(full);r.agent.cacheTtl=ttl;r.agent.cacheKeepalive.refreshAfterMinutes=below(limit);
    expect(run(r).status).toBe(0);r.agent.cacheKeepalive.refreshAfterMinutes=limit;refuses(r);
  }
  const r=structuredClone(full);r.agent.thinking.budgetTokens=below(r.agent.maxTokens);
  expect(run(r).status).toBe(0);r.agent.thinking.budgetTokens=r.agent.maxTokens;refuses(r);
  const q=structuredClone(full);q.agent.strategy.kvUnified.policy.budgetLowRatio=0.9;refuses(q);
});
const enumAudit: Array<[string,string[],string]> = [
  ['agent.strategy.type',['autobiographical','passthrough','frontdesk'],'2556–2568'],
  ['agent.strategy.foldingStrategy',['flat-profile','oldest-first','kv-stable','kv-unified'],'2571–2583'],
  ['agent.thinking.type',['enabled','adaptive'],'2506–2507'],
  ['agent.thinking.display',['summarized','omitted'],'2509–2510'],
  ['agent.proseRouting',['locus','explicit','hybrid','disabled'],'2265–2272'],
  ['agent.cacheTtl',['5m','1h'],'2385–2388'],
  ['mcpServers.local.transport',['stdio','websocket'],'529'],
  ['mcpServers.local.source.install',['npm','pip-editable'],'2759–2772'],
  ['mcpServers.local.source.install.runtime',['node','python3','custom','bun'],'2762–2771'],
  ['mcpServers.local.channelSubscription',['auto','manual'],'590–594 (+ string[] branch)'],
  ['modules.workspace.mounts.0.mode',['read-write','read-only'],'2010,2033'],
  ['modules.workspace.mounts.0.watch',['always','on-agent-action','never'],'2012,2035'],
  ['modules.workspace.mounts.0.wakeOnChange.0',['created','modified','deleted'],'2013,2046 (+ boolean branch)'],
];
for(const [slot,values,line] of enumAudit)test(`CLI host enum ${slot} (${line})`,()=>{
  for(const value of values){
    const r=changed(slot.split('.'),value) as typeof full;
    if(slot==='agent.strategy.type'||slot==='agent.strategy.foldingStrategy'){
      // A custom kv block is not valid with a non-kv planner / passthrough.
      delete (r.agent.strategy as {kvUnified?:unknown}).kvUnified;
      if(value==='passthrough')r.agent.strategy.foldingStrategy='oldest-first';
    }
    expect(run(r).status).toBe(0);
  }
  refuses(changed(slot.split('.'),'unsupported-enum'));
});
test('CLI rejects malformed union branches and admits supported alternates',()=>{
  for(const value of [42,{},[false],['channel',{}]])refuses(changed(['mcpServers','local','channelSubscription'],value));
  for(const value of ['manual',[]])expect(run(changed(['mcpServers','local','channelSubscription'],value)).status).toBe(0);
  for(const key of ['subagents','retrieval','workspace','activity'])expect(run(changed(['modules',key],true)).status).toBe(0);
  expect(run(changed(['modules','workspace','mounts',0,'wakeOnChange'],false)).status).toBe(0);
  for(const value of ['npm','pip-editable'])expect(run(changed(['mcpServers','local','source','install'],value)).status).toBe(0);
  refuses(changed(['mcpServers','local','source','install'],'unsupported-enum'));
});

test('cook sourceMeta provenance has types but no host install enum',()=>{
  for(const path of [['mcpServers','local','sourceMeta','install'],['mcpServers','local','sourceMeta','install','runtime']]){
    expect(run(changed(path,'historical-install-label')).status).toBe(0);
    refuses(changed(path,42));
  }
});

test('host default strategy type and empty channel list entries remain type-valid',()=>{
  const r=structuredClone(full);delete (r.agent.strategy as {type?:string}).type;
  expect(run(r).status).toBe(0);
  expect(run(changed(['mcpServers','local','channelSubscription'],[''])).status).toBe(0);
});
