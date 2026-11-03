/** Stable private build paths, publication by atomic symlink only. No activation. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, hash, parseJSON, validateStaged, type Manifest, type StagedEnvelope } from './candidate/schema.js';
import { deploymentRevision, exportManifest, materializationV1 } from './candidate/manifest.js';
import { exists, noLinks, privateDir, syncTree, syncDir } from './candidate/io.js';
import { provisionPrivateDirectory } from './private-directory.js';
import { parseHostDependencies } from './host-dependency.js';
import { hostLayout } from './host-layout.js';
import { credentialBindings } from './host-credentials.js';
import { readDeployRepo, refuse, type DeployPlan } from './deploy-repo.js';
import type { Recipe } from './vendor/recipe.js';

export const planId = (plan: DeployPlan): string => hash(canonical(plan)).slice(7);
function paths(root: string, plan: DeployPlan) {
  root=resolve(root); const id=planId(plan);
  return {root,id,build:join(root,'.builds',id),link:join(root,'runtimes',id)};
}
function complete(plan: DeployPlan): void { if(plan.missing.length)refuse('E_DEPLOY_MISSING'); }
function write(path: string, value: string): void { writeFileSync(path,value,{mode:0o600,flag:'wx'}); }
function readMetadata(path: string): string {
  noLinks(path); const st=lstatSync(path);
  if(!st.isFile()||st.nlink!==1||st.uid!==process.geteuid?.()||st.size>16*1024*1024)refuse('E_DEPLOY_FILE');
  return readFileSync(path,'utf8');
}
function digestFile(path: string): string { return 'sha256:'+createHash('sha256').update(readFileSync(path)).digest('hex'); }
/** No following links into external mutable roles; same-uid hostile concurrent
 * mutation is outside the private-directory threat model used by legacy cook. */
function inventory(root: string, excluded: string[] = []): string {
  const rows: unknown[]=[];
  const walk=(dir:string) => {
    for(const name of readdirSync(dir).sort()) {
      const file=join(dir,name), rel=relative(root,file);
      if(excluded.some(p=>file===p||file.startsWith(p+'/')))continue;
      if(['.cook/tree.json','connectome.deployment.json'].includes(rel))continue;
      const st=lstatSync(file);
      if(st.uid!==process.geteuid?.())refuse('E_DEPLOY_OWNER');
      if(st.isSymbolicLink()) {
        const target=realpathSync(file);
        if(excluded.some(p=>target===p||target.startsWith(p+'/'))||(target!==root&&!target.startsWith(root+'/')))refuse('E_DEPLOY_EXTERNAL_LINK');
        rows.push([rel,'link',readlinkSync(file)]);
      } else if(st.isDirectory()){rows.push([rel,'dir',st.mode&0o7777]);walk(file);}
      else if(st.isFile())rows.push([rel,'file',st.mode&0o7777,digestFile(file)]);
      else refuse('E_DEPLOY_FILE');
    }
  };
  walk(root); return canonical(rows)+'\n';
}
function engineIdentity(plan: DeployPlan): string {
  return canonical([plan.host.bunPath!,plan.host.nodePath!].map(path=>{
    const actual=realpathSync(path),st=lstatSync(actual);
    if(!st.isFile()||!(st.mode&0o111))refuse('E_DEPLOY_ENGINE');
    return {path,actual,digest:digestFile(actual)};
  }))+'\n';
}
function expandedOptions(plan: DeployPlan, build: string) {
  const h=JSON.parse(JSON.stringify(plan.host).replaceAll('{build}',build)) as typeof plan.host;
  const install=h.layout?.runtime??join(build,'runtime');
  if(install!==build&&!install.startsWith(build+'/'))refuse('E_DEPLOY_SCOPE');
  if(h.layout) {
    hostLayout(h.layout,install);
    for(const role of ['runtime','config','state','workspace','credentials'] as const)
      if(!h.layout[role].startsWith(build+'/'))refuse('E_DEPLOY_SCOPE');
  }
  if(h.credentialBindings)credentialBindings(h.credentialBindings);
  return {h,install};
}
function privateRoles(plan: DeployPlan, build: string): string[] {
  const {h}=expandedOptions(plan,build);
  return [...(h.layout?[h.layout.state,h.layout.workspace,h.layout.credentials]:[]),...(h.credentialBindings?[h.credentialBindings.root]:[])];
}
function stageScope(recipe: Recipe): void {
  for(const server of Object.values(recipe.mcpServers??{}))if(server.command&&!server.source)refuse('E_DEPLOY_SOURCE_MISSING');
  // Do not fetch child recipes or adopt local source/config/credential payloads
  // that the plan has not validated and digested.
  const inspect=(v:unknown):void=>{
    if(Array.isArray(v)){v.forEach(inspect);return;}
    if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){
      if(['children','credentialFiles','templateFiles','services','localPath'].includes(k))refuse('E_DEPLOY_SCOPE');
      if(k==='extensions' && Object.keys(x as object).length)refuse('E_DEPLOY_SCOPE');
      inspect(x);
    }
  };inspect(recipe);
}
/** Production installer boundary. All legacy G1–G5 options go through cook
 * install, with no inherited secrets/auth hooks and no child output in logs. */
function installLegacy(plan: DeployPlan, build: string): void {
  const {h,install}=expandedOptions(plan,build);
  const args=[fileURLToPath(new URL('../bin/cook',import.meta.url)),'install',join(build,'.cook/recipe.json'),'--out',install,'--no-prompts','--yes','--pin-refs',
    '--ch-repo',h.chRepo!,'--ch-ref',h.chRef!,'--bun-path',h.bunPath!,'--node-path',h.nodePath!];
  if(h.userUnit)args.push('--user-unit',h.userUnit);
  for(const d of h.hostDependencies!)args.push('--host-dependency',d);
  for(const [key,flag] of [['layout','--layout'],['credentialBindings','--credential-bindings']] as const)if(h[key]){
    const p=join(build,'.cook',key+'.json');write(p,canonical(h[key]));args.push(flag,p);
  }
  const home=join(build,'.cook/build-home');mkdirSync(home,{mode:0o700});
  const result=spawnSync(process.execPath,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,
    env:{PATH:`${dirname(h.bunPath!)}:${dirname(h.nodePath!)}:/usr/bin:/bin`,HOME:home,LANG:'C.UTF-8',CI:'1',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ASKPASS:'/bin/false'}});
  rmSync(home,{recursive:true,force:true});
  if(result.status!==0)refuse('E_DEPLOY_BUILD');
}
function makeManifest(plan: DeployPlan, build: string): StagedEnvelope {
  const {install}=expandedOptions(plan,build);
  const bytes=readFileSync(join(install,'connectome.lock'),'utf8');
  const raw=JSON.parse(bytes);
  const owner={uid:process.geteuid!(),gid:process.getegid!()};
  const roles: Manifest['roles']=[{name:'runtime',kind:'runtime',path:install,owner},{name:'config',kind:'config',path:join(build,'.cook'),owner}];
  const layout=expandedOptions(plan,build).h.layout;
  if(layout)for(const kind of ['state','workspace','credentials'] as const)roles.push({name:kind,kind,path:layout[kind],owner});
  const artifacts: Manifest['artifacts']=[{name:'recipe',role:'config',path:'recipe.json',digest:digestFile(join(build,'.cook/recipe.json'))},
    {name:'tree',role:'config',path:'tree.json',digest:digestFile(join(build,'.cook/tree.json'))}];
  const roots=[raw.connectomeHost.path,...raw.components.map((c:{path:string})=>c.path),...raw.localExtensions.map((c:{path:string})=>c.path)] as string[];
  for(const [i,p] of roots.entries()){
    if(!p.startsWith(install+'/'))refuse('E_DEPLOY_SCOPE');
    artifacts.push({name:'code-'+i,role:'runtime',path:relative(install,p),digest:hash(inventory(p))});
  }
  const profiles=Object.keys(plan.configuration.units).sort();
  const providers: Manifest['providers']=[];
  // Descriptive systemd routes cannot be installed by G3; retain their intent
  // in the plan. G3's explicit named consumer mappings are the build bindings.
  const c=expandedOptions(plan,build).h.credentialBindings;
  if(c){
    if(!roles.some(r=>r.name==='credentials'))roles.push({name:'credentials',kind:'credentials',path:c.root,owner});
    for(const [name,destination] of Object.entries(c.files).sort(([a],[b])=>a.localeCompare(b)))providers.push({name,required:true,consumer:profiles[0]!,role:'credentials',destination});
  }
  for(const credential of plan.configuration.credentials) {
    const root=dirname(credential.source);
    let role=roles.find(r=>r.kind==='credentials'&&r.path===root);
    if(!role){role={name:'credential-route-'+roles.length,kind:'credentials',path:root,owner};roles.push(role);}
    if(providers.some(p=>p.name===credential.name))refuse('E_DEPLOY_BINDINGS');
    const profile=credential.consumer.split(':')[0]!;
    providers.push({name:credential.name,required:true,consumer:profiles.includes(profile)?profile:profiles[0]!,role:role.name,destination:relative(root,credential.source)});
  }
  const manifest: Manifest={revision:'',profiles,roles,providers,
    units:profiles.map(profile=>({name:plan.configuration.units[profile]!.name,scope:plan.host.userUnit===plan.configuration.units[profile]!.name?'user':'system',profile,artifacts:artifacts.map(a=>a.name),after:[]})),artifacts};
  const e: StagedEnvelope={schema:'connectome.deployment/v1',agent:{id:plan.host.agentId!,lineage:plan.host.lineage!},
    lifecycle:'staged-candidate',desired:{declaration:'.cook/deploy-plan.json',configDigest:hash(canonical(plan))},
    materialized:{lock:'connectome.lock',lockVersion:1,lockDigest:hash(bytes)},installed:null,running:null,manifest};
  e.manifest!.revision=deploymentRevision(e);exportManifest(e,bytes);return e;
}
function verifyBuild(plan: DeployPlan, build: string): void {
  privateDir(build);privateDir(join(build,'.cook'));
  if(readMetadata(join(build,'.cook/engines.json'))!==engineIdentity(plan))refuse('E_DEPLOY_ENGINE_DRIFT');
  const stored=readMetadata(join(build,'.cook/deploy-plan.json'));
  if(stored!==canonical(plan)+'\n')refuse('E_DEPLOY_PLAN_DRIFT');
  const envelopeBytes=readMetadata(join(build,'connectome.deployment.json'));
  const e=validateStaged(parseJSON(envelopeBytes));
  if(envelopeBytes!==canonical(e)+'\n')refuse('E_DEPLOY_MANIFEST_DRIFT');
  if(!e.manifest||e.desired.configDigest!==hash(canonical(plan))||e.agent.id!==plan.host.agentId||e.agent.lineage!==plan.host.lineage)refuse('E_DEPLOY_PLAN_DRIFT');
  const lock=materializationV1(e,readMetadata(join(build,'connectome.lock')));
  if(lock.connectomeHost.commit!==plan.host.chRef||lock.connectomeHost.url!==plan.host.chRepo)refuse('E_DEPLOY_PIN_DRIFT');
  if(hash(canonical(parseJSON(readMetadata(join(build,'.cook/recipe.json')))))!==plan.recipeDigest)refuse('E_DEPLOY_RECIPE_DRIFT');
  if(readMetadata(join(build,'.cook/tree.json'))!==inventory(build,privateRoles(plan,build)))refuse('E_DEPLOY_TREE_DRIFT');
  for(const a of e.manifest.artifacts){
    const role=e.manifest.roles.find(r=>r.name===a.role)!;const file=join(role.path,a.path);
    if(!file.startsWith(build+'/'))refuse('E_DEPLOY_SCOPE');
    noLinks(file);const digest=lstatSync(file).isDirectory()?hash(inventory(file)):digestFile(file);
    if(digest!==a.digest)refuse('E_DEPLOY_ARTIFACT_DRIFT');
  }
  if(canonical(e)!==canonical(makeManifest(plan,build)))refuse('E_DEPLOY_BINDING_DRIFT');
  const deps=parseHostDependencies(plan.host.hostDependencies);
  if(deps.length!==(lock.hostDependencies??[]).length||deps.some(d=>!lock.hostDependencies?.some(x=>x.name===d.name&&x.sha256===d.sha256)))refuse('E_DEPLOY_PIN_DRIFT');
}
export function checkDeploy(plan: DeployPlan, root: string): string {
  complete(plan);const p=paths(root,plan);
  privateDir(p.root);privateDir(join(p.root,'.builds'));privateDir(join(p.root,'runtimes'));
  const st=lstatSync(p.link);
  if(!st.isSymbolicLink()||st.uid!==process.geteuid?.()||readlinkSync(p.link)!==p.build)refuse('E_DEPLOY_LINK');
  verifyBuild(plan,p.build);return p.link;
}
export function stageDeploy(repo: string, slug: string, root: string): string {
  const {plan,recipe}=readDeployRepo(repo,slug);complete(plan);
  if(plan.configuration.hold)refuse('E_DEPLOY_HOLD_UNSUPPORTED');
  stageScope(recipe);
  const p=paths(root,plan);
  for(const dir of [p.root,join(p.root,'.builds'),join(p.root,'runtimes')])provisionPrivateDirectory(dir);
  if(exists(p.link))return checkDeploy(plan,root);
  if(exists(p.build))refuse('E_DEPLOY_INTERRUPTED');
  // mkdir is the exclusive reservation; never remove a directory we did not own.
  mkdirSync(p.build,{mode:0o700});
  const temp=join(p.root,'runtimes','.'+p.id+'.'+randomUUID());
  try {
    mkdirSync(join(p.build,'.cook'),{mode:0o700});
    write(join(p.build,'.cook/deploy-plan.json'),canonical(plan)+'\n');
    write(join(p.build,'.cook/recipe.json'),canonical(recipe)+'\n');
    write(join(p.build,'.cook/engines.json'),engineIdentity(plan));
    installLegacy(plan,p.build);
    // A split install's lock copy must precede the closure census.
    const {install}=expandedOptions(plan,p.build);
    if(install!==p.build)write(join(p.build,'connectome.lock'),readFileSync(join(install,'connectome.lock'),'utf8'));
    write(join(p.build,'.cook/tree.json'),inventory(p.build,privateRoles(plan,p.build)));
    const envelope=makeManifest(plan,p.build);
    write(join(p.build,'connectome.deployment.json'),canonical(envelope)+'\n');
    verifyBuild(plan,p.build);syncTree(p.build);
    symlinkSync(p.build,temp);if(exists(p.link))refuse('E_DEPLOY_LINK');renameSync(temp,p.link);syncDir(dirname(p.link));
    return p.link;
  } catch(error) { rmSync(temp,{force:true}); if(!exists(p.link))rmSync(p.build,{recursive:true,force:true});throw error; }
}
