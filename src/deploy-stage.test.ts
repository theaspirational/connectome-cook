import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readDeployRepo } from './deploy-repo.js';
import { checkDeploy, planId, stageDeploy } from './deploy-stage.js';
import { exportManifest } from './candidate/manifest.js';
import { validate } from './candidate/schema.js';
let dir:string, repo:string, root:string, source:string;
const write=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v));
beforeEach(()=>{
  dir=mkdtempSync(join(tmpdir(),'cook-deploy-stage-'));repo=join(dir,'repo');root=join(dir,'stage');source=join(dir,'source');
  mkdirSync(join(repo,'agents/fixture'),{recursive:true});mkdirSync(source);
  mkdirSync(join(dir,'package'));write(join(dir,'package/package.json'),{name:'fixture-dependency',version:'1.0.0'});
  const archive=join(dir,'dep.tgz');execFileSync('tar',['--format=ustar','-czf',archive,'package'],{cwd:dir});
  const sha=createHash('sha256').update(readFileSync(archive)).digest('hex');
  write(join(source,'package.json'),{name:'fixture-host',engines:{bun:'>=1.4.0',node:'>=22'},dependencies:{'fixture-dependency':'^1.0.0'}});
  mkdirSync(join(source,'src'));writeFileSync(join(source,'src/index.ts'),'// fixture, never launched\n');
  const git=(args:string[])=>execFileSync('git',args,{cwd:source,stdio:'pipe',encoding:'utf8'});
  git(['init','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);git(['add','.']);git(['commit','-m','fixture']);
  const ref=git(['rev-parse','HEAD']).trim();
  write(join(repo,'versions.yml'),{runtime:ref});
  write(join(repo,'agents/fixture/agent.yml'),{host:'fixture',user:'fixture',hold:false,layout:'legacy-support-agents',paths:{},release:'fixture',units:{main:{name:'fixture.service',exec_start:['/bin/false'],unit:{},service:{},environment:{},install:{}}},credentials:[],seed_settings:null,versions:{}});
  write(join(repo,'agents/fixture/recipe.json'),{name:'Fixture',agent:{systemPrompt:'Fixture'}});
  const node=join(dir,'node');writeFileSync(node,'#!/bin/sh\necho v22.23.3\n');chmodSync(node,0o755);
  write(join(repo,'agents/fixture/host.yml'),{chRepo:source,chRef:'{runtime}',bunPath:process.execPath,nodePath:node,hostDependencies:[`fixture-dependency=${archive}#sha256=${sha}`],userUnit:'fixture.service',agentId:'01234567-89ab-cdef-0123-456789abcdef',lineage:'abcdef01-2345-6789-abcd-ef0123456789'});
});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
function plan(){return readDeployRepo(repo,'fixture').plan;}
function cli(command:string, extra:string[]=[]){return spawnSync(process.execPath,[resolve('bin/cook'),'deploy',command,'--repo',repo,'--agent','fixture',...extra],{encoding:'utf8'});}
test('real legacy install with G5, staged manifest export, idempotent restage, no current mutation',()=>{
  const link=stageDeploy(repo,'fixture',root),p=plan(),build=join(root,'.builds',planId(p));
  expect(readlinkSync(link)).toBe(build);expect(checkDeploy(p,root)).toBe(link);
  const before=lstatSync(link).mtimeMs, files=readdirSync(build);
  expect(stageDeploy(repo,'fixture',root)).toBe(link);expect(lstatSync(link).mtimeMs).toBe(before);expect(readdirSync(build)).toEqual(files);
  expect(existsSync(join(root,'current'))).toBe(false);
  const envelope=JSON.parse(readFileSync(join(build,'connectome.deployment.json'),'utf8'));
  const lock=readFileSync(join(build,'connectome.lock'),'utf8');
  expect(JSON.parse(exportManifest(envelope,lock)).lifecycle).toBe('staged-candidate');
  expect(()=>validate('connectome.deployment/v1',envelope)).toThrow();
  expect(JSON.parse(lock).hostDependencies[0].sha256).toHaveLength(64);
  expect(existsSync(join(build,'runtime/fixture.service'))).toBe(true);
});
test('failed build never publishes and cleans only its owned build',()=>{
  const file=join(repo,'agents/fixture/host.yml'),h=JSON.parse(readFileSync(file,'utf8'));
  h.chRef='f'.repeat(40);write(file,h);const id=planId(plan());
  expect(()=>stageDeploy(repo,'fixture',root)).toThrow('E_DEPLOY_BUILD');
  expect(existsSync(join(root,'runtimes',id))).toBe(false);expect(existsSync(join(root,'.builds',id))).toBe(false);
});
test('interrupted build refuses without publishing or deleting leftovers',()=>{
  const build=join(root,'.builds',planId(plan()));mkdirSync(build,{recursive:true,mode:0o700});
  writeFileSync(join(build,'partial'),'incomplete');
  expect(()=>stageDeploy(repo,'fixture',root)).toThrow('E_DEPLOY_INTERRUPTED');
  expect(readFileSync(join(build,'partial'),'utf8')).toBe('incomplete');
});
test('tampered publication target and foreign existing runtime refuse',()=>{
  mkdirSync(join(root,'runtimes'),{recursive:true,mode:0o700});
  const link=join(root,'runtimes',planId(plan()));symlinkSync(source,link);
  expect(()=>stageDeploy(repo,'fixture',root)).toThrow();expect(readlinkSync(link)).toBe(source);
  rmSync(link);mkdirSync(link);expect(()=>stageDeploy(repo,'fixture',root)).toThrow();
});
for(const file of ['runtime/app/src/index.ts','.cook/recipe.json','.cook/deploy-plan.json','connectome.lock','connectome.deployment.json'])test('check detects tampering: '+file,()=>{
  const link=stageDeploy(repo,'fixture',root);const build=readlinkSync(link);
  writeFileSync(join(build,file),readFileSync(join(build,file),'utf8')+' ');
  expect(()=>checkDeploy(plan(),root)).toThrow();
  expect(()=>stageDeploy(repo,'fixture',root)).toThrow();
});
test('plan is side effect free and CLI missing fields refuses before creating root',()=>{
  rmSync(join(repo,'agents/fixture/host.yml'));
  const result=cli('plan');expect(result.status).toBe(0);expect(JSON.parse(result.stdout).missing).toContain('chRef');
  for(const command of ['stage','check']){const r=cli(command,['--root',root]);expect(r.status).toBe(2);expect(r.stderr).toContain('E_DEPLOY_MISSING');}
  expect(existsSync(root)).toBe(false);
});
test('private root modes and symlink ancestors refuse before build',()=>{
  mkdirSync(root,{mode:0o755});expect(()=>stageDeploy(repo,'fixture',root)).toThrow();
  rmSync(root,{recursive:true});symlinkSync(source,root);expect(()=>stageDeploy(repo,'fixture',root)).toThrow();
});
test('metadata symlinks refuse without following foreign files',()=>{
  const link=stageDeploy(repo,'fixture',root),build=readlinkSync(link);
  const file=join(build,'.cook/deploy-plan.json');rmSync(file);symlinkSync('/dev/zero',file);
  expect(()=>checkDeploy(plan(),root)).toThrow();
});
test('CLI secret errors contain neither values nor unknown supplied keys',()=>{
  const sentinel='ghp_SYNTHETIC_PRIVATE_SENTINEL';
  write(join(repo,'agents/fixture/host.yml'),{[sentinel]:sentinel});
  const r=cli('plan');expect(r.status).not.toBe(0);expect(r.stdout).toBe('');expect(r.stderr).not.toContain(sentinel);
});
test('existing current is not changed and runtime link tampering is detected',()=>{
  mkdirSync(root,{mode:0o700});symlinkSync('/nonexistent/retained',join(root,'current'));
  const link=stageDeploy(repo,'fixture',root);
  expect(readlinkSync(join(root,'current'))).toBe('/nonexistent/retained');
  rmSync(link);symlinkSync(source,link);expect(()=>checkDeploy(plan(),root)).toThrow('E_DEPLOY_LINK');
});
test('G1/G2/G3 split options reuse legacy install, never read credential files',()=>{
  const file=join(repo,'agents/fixture/host.yml'),h=JSON.parse(readFileSync(file,'utf8'));
  const credentials=join(dir,'credentials');mkdirSync(credentials,{mode:0o700});
  writeFileSync(join(credentials,'auth'), 'synthetic-private-value',{mode:0o600});
  h.layout={schema:'connectome.host-layout/v1',runtime:'{build}/runtime',config:'{build}/config',state:'{build}/state',workspace:'{build}/workspace',credentials:'{build}/credentials',connectorState:{}};
  h.credentialBindings={schema:'connectome.credential-bindings/v1',root:'{build}/credentials',files:{auth:'auth'},consumers:{local:{API_KEY:'auth'}}};
  write(file,h);write(join(repo,'agents/fixture/recipe.json'),{name:'Fixture',agent:{systemPrompt:'Fixture'},mcpServers:{local:{command:'node',args:['src/index.ts'],source:{url:source,ref:'{runtime}',install:{runtime:'custom',run:'/bin/true'}}}}});
  const link=stageDeploy(repo,'fixture',root),build=readlinkSync(link);
  expect(checkDeploy(plan(),root)).toBe(link);
  const envelope=readFileSync(join(build,'connectome.deployment.json'),'utf8');
  expect(envelope).not.toContain('synthetic-private-value');
  expect(existsSync(join(build,'config/recipes/recipe.json'))).toBe(true);
  // Private roles never enter closure inventories, even if later populated.
  writeFileSync(join(build,'credentials/auth'),'synthetic-private-value',{mode:0o600});
  expect(checkDeploy(plan(),root)).toBe(link);
});
test('selected engine byte changes invalidate check and restage',()=>{
  stageDeploy(repo,'fixture',root);writeFileSync(join(dir,'node'),'#!/bin/sh\necho v22.99.0\n');
  expect(()=>checkDeploy(plan(),root)).toThrow('E_DEPLOY_ENGINE_DRIFT');
  expect(()=>stageDeploy(repo,'fixture',root)).toThrow('E_DEPLOY_ENGINE_DRIFT');
});
