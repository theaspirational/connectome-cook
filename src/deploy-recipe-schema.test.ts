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
    formatter:'native',contextBudgetTokens:100,thinking:{enabled:true,type:'adaptive',display:'summarized',budgetTokens:0},
    cacheKeepalive:{enabled:true,refreshAfterMinutes:1,maxIdleHours:0},maxStreamTokens:100,proseRouting:'disabled',cacheTtl:'1h',
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
    enabledTools:['a'],disabledTools:['b'],reconnect:true,reconnectIntervalMs:0,channelSubscription:['channel'],source:git,sourceMeta:git,
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
for(const {path,value} of slots.filter(x=>typeof x.value==='number'))test('CLI rejects negative numeric domain at '+path.join('.'),()=>{
  refuses(changed(path,-1));
  if((value as number)>0 && /(?:Tokens|BucketSize|Threshold|Ceiling|HalfLife|TimeoutMs|MaxTokens)$/.test(String(path.at(-1))))refuses(changed(path,0.5));
});
for(const path of [
  ['agent','strategy','type'],['mcpServers','local','transport'],['mcpServers','local','source','install','runtime'],
  ['modules','workspace','mounts',0,'mode'],['modules','workspace','mounts',0,'watch'],
  ['modules','workspace','mounts',0,'wakeOnChange',0],['mcpServers','remote','channelSubscription'],
] satisfies Path[])test('CLI rejects unsupported enum at '+path.join('.'),()=>refuses(changed(path,'unsupported-enum')));
for(const path of [
  ['agent','strategy','compressionSlackRatio'],['agent','strategy','overBudgetGraceRatio'],
  ...['alpha','budgetLowRatio','budgetHighRatio','continuityRecencyFloor','continuityStableFloor'].map(k=>['agent','strategy','kvUnified','policy',k]),
] satisfies Path[])test('CLI rejects ratio above one at '+path.join('.'),()=>refuses(changed(path,1.1)));
test('CLI rejects malformed union branches and admits supported alternates',()=>{
  for(const value of [42,{},[false],['channel',{}]])refuses(changed(['mcpServers','local','channelSubscription'],value));
  for(const value of ['manual',[]])expect(run(changed(['mcpServers','local','channelSubscription'],value)).status).toBe(0);
  for(const key of ['subagents','retrieval','workspace','activity'])expect(run(changed(['modules',key],true)).status).toBe(0);
  expect(run(changed(['modules','workspace','mounts',0,'wakeOnChange'],false)).status).toBe(0);
  for(const value of ['npm','pip-editable'])expect(run(changed(['mcpServers','local','source','install'],value)).status).toBe(0);
  refuses(changed(['mcpServers','local','source','install'],'unsupported-enum'));
});
