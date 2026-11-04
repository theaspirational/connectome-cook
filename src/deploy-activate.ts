/** Repo activation. No credential payload or state directory is opened. */
import { constants as F, accessSync, closeSync, fchmodSync, fsyncSync, lstatSync, openSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { canonical, parseJSON } from './candidate/schema.js';
import { admitFilesystem, exists, flock, noLinks, privateDir, privateFile, readPrivate, syncDir } from './candidate/io.js';
import { checkDeploy, planId } from './deploy-stage.js';
import { object, readDeployRepo, refuse, type DeployPlan } from './deploy-repo.js';
import { validateUserUnit } from './host-unit.js';

type Units = Record<string,string>;
interface Snapshot { id: string; units: Units; unitDir: string; scope: 'user'|'system'; enabled: Record<string,boolean> }
interface Entry { before: Snapshot|null; after: Snapshot; phase: 'pending'|'active'|'restored' }
const idOK = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
function absolute(p: string): string {
  if (!p.startsWith('/') || resolve(p)!==p || /[\x00-\x20\x7f%\\:"{}]/.test(p)) refuse('E_DEPLOY_PATH');
  return p;
}
function quote(s: string, exec=false): string {
  if (/[\x00-\x1f\x7f]/.test(s)) refuse();
  return '"'+s.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/%/g,'%%').replace(/\$/g,exec?'$$$$':'$')+'"';
}
/** Read identity/config metadata without inspecting the executable payload. */
function storedDeclaration(root: string,id: string): DeployPlan {
  if(!idOK(id))refuse();
  const plan=parseJSON(readPrivate(join(root,'.builds',id,'.cook/deploy-plan.json'))) as DeployPlan;
  if(planId(plan)!==id)refuse('E_DEPLOY_PLAN_DRIFT');
  return plan;
}
function storedPlan(root: string,id: string): DeployPlan {
  const plan=storedDeclaration(root,id);
  checkDeploy(plan,root);return plan;
}
function userIdentity(plan: DeployPlan, scope: string): void {
  if(scope!=='user')return;
  const account=plan.configuration.user;
  if(!/^[A-Za-z0-9_][A-Za-z0-9_.-]*[$]?$/.test(account))refuse('E_DEPLOY_IDENTITY');
  const identity=(flag:string)=>{
    const r=spawnSync('/usr/bin/id',[flag,'--',account],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']});
    if(r.status!==0||!/^\d+\n?$/.test(r.stdout))refuse('E_DEPLOY_IDENTITY');
    return Number(r.stdout.trim());
  };
  if(identity('-u')!==process.geteuid?.()||identity('-g')!==process.getegid?.())refuse('E_DEPLOY_IDENTITY');
  // Per-unit identity changes are unsupported in the invoking user manager.
  if(Object.values(plan.configuration.units).some(u=>u.service.User||u.service.Group))refuse('E_DEPLOY_IDENTITY');
}
function effective(entries: Entry[]): {current:Snapshot|null;previous:Snapshot|null} {
  let current:Snapshot|null=null,previous:Snapshot|null=null;
  for(const e of entries) {
    if(e.phase==='active'){if(e.before?.id!==e.after.id)previous=e.before;current=e.after;}
    // A restored attempt changes no effective predecessor. Retain the observed
    // before snapshot (including enablement), not the failed candidate.
    else if(e.phase==='restored')current=e.before;
  }
  return {current,previous};
}
function rollbackSelection(entries: Entry[], to?: string): {from:Snapshot|null; target:Snapshot|null} {
  const last=entries.at(-1);
  if(last?.phase==='pending') {
    if(to)refuse('E_DEPLOY_RECOVERY_REQUIRED');
    return {from:last.after,target:last.before};
  }
  const history=effective(entries),id=to??history.previous?.id;
  const target=entries.filter(e=>e.phase!=='pending')
    .flatMap(e=>e.phase==='active'?[e.before,e.after]:[e.before]).reverse().find(s=>s?.id===id);
  if(!target)refuse('E_DEPLOY_ROLLBACK');
  return {from:history.current,target};
}
/** Admission is read-only and scoped to the selected transition. A discarded
 * executable is never a prerequisite for stopping it or restoring intact code.
 * Metadata still has to bind to its runtime ID to establish account identity. */
function admitRollback(root:string,entries:Entry[],to?:string) {
  const selected=rollbackSelection(entries,to);
  for(const s of [selected.from,selected.target])if(s)userIdentity(storedDeclaration(root,s.id),s.scope);
  if(selected.target)storedPlan(root,selected.target.id);
  return selected;
}
export function renderDeployUnits(plan: DeployPlan, root: string, mapping: Record<string,string>, scope: 'user'|'system'): Units {
  userIdentity(plan,scope);
  if(plan.configuration.hold)refuse('E_DEPLOY_HOLD');
  const state=plan.host.stateDirectory;
  if(!state)refuse('E_DEPLOY_STATE_REQUIRED');
  absolute(state); noLinks(state); if(!lstatSync(state).isDirectory())refuse('E_DEPLOY_STATE_REQUIRED');
  const names=plan.configuration.credentials.map(c=>c.name);
  if(Object.keys(mapping).length!==names.length || names.some(n=>!Object.hasOwn(mapping,n)))refuse('E_DEPLOY_CREDENTIAL_MAP');
  for(const p of Object.values(mapping))absolute(p); // Deliberately never stat/open credential targets.
  const units: Units={};
  const expand=(s:string)=>s.replaceAll('{runtime}',(plan.host.layout?.runtime?.replaceAll('{build}',join(root,'.builds',planId(plan)))??join(root,'.builds',planId(plan),'runtime'))).replaceAll('{state}',state);
  for(const [profile,u] of Object.entries(plan.configuration.units).sort(([a],[b])=>a.localeCompare(b))) {
    if(!u.install.WantedBy||!u.install.WantedBy.split(' ').every(n=>/^[A-Za-z0-9_.@-]+\.target$/.test(n)))refuse('E_DEPLOY_ENABLEMENT');
    if(u.exec_start_pre || u.service.RuntimeDirectory || u.service.RuntimeDirectoryMode)refuse('E_DEPLOY_SCOPE');
    const args=u.exec_start.map(expand);
    if(!args[0]?.startsWith('/') || args.some(a=>/[{}]/.test(a)))refuse('E_DEPLOY_UNIT');
    const service={Type:'simple',Restart:'on-failure',...u.service,WorkingDirectory:state};
    if(u.service.WorkingDirectory && expand(u.service.WorkingDirectory)!==state)refuse('E_DEPLOY_SCOPE');
    if(scope==='system')Object.assign(service,{User:u.service.User??plan.configuration.user});
    else if(u.service.User||u.service.Group)refuse('E_DEPLOY_SCOPE');
    const fields=(o:Record<string,string>)=>Object.entries(o).sort().map(([k,v])=>{
      v=expand(v);if(/[\r\n\\{}]/.test(v))refuse('E_DEPLOY_UNIT');
      return k+'='+v.replace(/%/g,'%%');
    });
    const lines=['[Unit]',...fields(u.unit),'','[Service]',...fields(service),'ExecStart='+args.map(a=>quote(a,true)).join(' ')];
    for(const [k,v] of Object.entries(u.environment).sort()) {
      if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)||/\$\{|[{}]/.test(v))refuse('E_DEPLOY_UNIT');
      lines.push('Environment='+quote(k+'='+v));
    }
    for(const c of plan.configuration.credentials) {
      if(c.deliver!=='systemd-credential'||!Object.hasOwn(plan.configuration.units,c.consumer)||c.destination)refuse('E_DEPLOY_SCOPE');
      if(c.consumer===profile)lines.push('LoadCredential='+c.name+':'+mapping[c.name]);
    }
    lines.push('','[Install]',...fields(u.install),'');
    units[u.name]=lines.join('\n');
  }
  return units;
}
function current(root:string): string|null {
  const p=join(root,'current');if(!exists(p))return null;
  const st=lstatSync(p),target=readlinkSync(p);
  if(!st.isSymbolicLink()||st.uid!==process.getuid?.()||!/^runtimes\/[a-f0-9]{64}$/.test(target))refuse('E_DEPLOY_CURRENT');
  return target.slice(9);
}
function journal(root:string): Entry[] {
  const p=join(root,'activation.jsonl');if(!exists(p))return [];
  const bytes=readPrivate(p);if(!bytes.endsWith('\n'))refuse('E_DEPLOY_JOURNAL');
  return bytes.trimEnd().split('\n').map(line=>{
    const e=object(parseJSON(line));
    if(Object.keys(e).sort().join(',')!=='after,before,phase'||!['pending','active','restored'].includes(String(e.phase)))refuse('E_DEPLOY_JOURNAL');
    for(const s of [e.before,e.after])if(s!==null){
      const v=object(s);
      if(Object.keys(v).sort().join(',')!=='enabled,id,scope,unitDir,units'||!idOK(v.id)||!['user','system'].includes(String(v.scope)))refuse('E_DEPLOY_JOURNAL');
      absolute(v.unitDir as string);
      const enabled=object(v.enabled);
      if(Object.keys(enabled).sort().join(',')!==Object.keys(object(v.units)).sort().join(',')||Object.values(enabled).some(x=>typeof x!=='boolean'))refuse('E_DEPLOY_JOURNAL');
      for(const [n,b] of Object.entries(object(v.units))){validateUserUnit(n);if(typeof b!=='string')refuse();}
    }
    if(!e.after)refuse();return e as unknown as Entry;
  });
}
function append(root:string,e:Entry) {
  const p=join(root,'activation.jsonl');if(exists(p))privateFile(p);
  const fd=openSync(p,F.O_WRONLY|F.O_APPEND|F.O_CREAT|F.O_NOFOLLOW,0o600);
  try{fchmodSync(fd,0o600);writeFileSync(fd,canonical(e)+'\n');fsyncSync(fd);}finally{closeSync(fd);}syncDir(root);
}
function atomic(path:string,bytes:string) {
  const temp=join(dirname(path),'.cook-'+randomUUID()),fd=openSync(temp,'wx',0o600);
  try{fchmodSync(fd,0o600);writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temp,path);syncDir(dirname(path));
}
function switchCurrent(root:string,id:string|null) {
  if(id===null){if(exists(join(root,'current')))unlinkSync(join(root,'current'));}
  else {const temp=join(root,'.current-'+randomUUID());symlinkSync('runtimes/'+id,temp);renameSync(temp,join(root,'current'));}
  syncDir(root);
}
function unitDir(p:string) {
  absolute(p);noLinks(p);const st=lstatSync(p);
  if(!st.isDirectory()||st.uid!==process.getuid?.()||(st.mode&0o022)||!(st.mode&0o200))refuse('E_DEPLOY_UNIT_DIR');
  accessSync(p,F.W_OK);
}
function install(next:Snapshot|null,other:Snapshot) {
  unitDir(other.unitDir);
  for(const [name,bytes] of Object.entries(next?.units??{}))atomic(join(other.unitDir,name),bytes);
  for(const name of Object.keys(other.units))if(!next?.units[name]&&exists(join(other.unitDir,name)))unlinkSync(join(other.unitDir,name));
  syncDir(other.unitDir);
}
function ctl(command:string,scope:string,verb:string,names:string[]=[]) {
  const r=spawnSync(command,[scope==='user'?'--user':'--system',verb,...names],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:5000,maxBuffer:65536});
  return r.status===0;
}
function observeEnabled(command:string,s:Snapshot,name:string):boolean {
  const r=spawnSync(command,[s.scope==='user'?'--user':'--system','is-enabled',name],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:5000,maxBuffer:65536});
  const state=r.stdout?.trim();
  if(r.status===0&&state==='enabled')return true;
  if(r.status!==null&&r.status!==0&&(state==='disabled'||state==='not-found'))return false;
  refuse('E_DEPLOY_ENABLEMENT');
}
function disableUnits(command:string,s:Snapshot,other:Snapshot|null) {
  const names=[...new Set([...Object.keys(s.units),...Object.keys(other?.units??{})])];
  const enabled=names.filter(n=>observeEnabled(command,s,n));
  if(enabled.length&&!ctl(command,s.scope,'disable',enabled))refuse('E_DEPLOY_ENABLEMENT');
}
function enableUnits(command:string,s:Snapshot|null) {
  if(!s)return;
  for(const name of Object.keys(s.units))if(s.enabled[name]){
    if(!ctl(command,s.scope,'enable',[join(s.unitDir,name)])||!observeEnabled(command,s,name))refuse('E_DEPLOY_ENABLEMENT');
  }
}
function persistenceWarning(scope:string):string[] {
  // No loginctl calls or machine policy changes. Without a qualified linger
  // observation, explicitly warn rather than pretending enablement ensures boot.
  return scope==='user'?['W_DEPLOY_LINGER_UNVERIFIED: user-manager boot persistence requires operator-verified linger; Cook does not enable linger.']:[];
}
async function restart(s:Snapshot,command:string,timeout:number) {
  if(!ctl(command,s.scope,'daemon-reload')||!ctl(command,s.scope,'restart',Object.keys(s.units)))refuse('E_DEPLOY_SYSTEMCTL');
  const end=Date.now()+timeout;
  do {
    if(Object.keys(s.units).every(n=>ctl(command,s.scope,'is-active',['--quiet',n])))return;
    await new Promise(r=>setTimeout(r,100));
  }while(Date.now()<end);
  refuse('E_DEPLOY_HEALTH');
}
async function restore(root:string,e:Entry,command:string,timeout:number) {
  if(e.before)storedPlan(root,e.before.id);
  if(!ctl(command,e.after.scope,'stop',Object.keys(e.after.units)))refuse('E_DEPLOY_RECOVERY');
  disableUnits(command,e.after,e.before);
  install(e.before,e.after);enableUnits(command,e.before);switchCurrent(root,e.before?.id??null);
  if(e.before)await restart(e.before,command,timeout);
  else if(!ctl(command,e.after.scope,'daemon-reload'))refuse('E_DEPLOY_RECOVERY');
  append(root,{...e,phase:'restored'});
}
export async function activationCommand(command:string,o:Record<string,string>, point?: (point: 'units-installed')=>void): Promise<unknown> {
  const root=resolve(o['--root']!);privateDir(root);
  if(command==='status') {
    const entries=journal(root),history=effective(entries);
    return {current:current(root),previous:history.previous?.id??null,journal:entries.map(e=>({phase:e.phase,before:e.before?.id??null,after:e.after.id}))};
  }
  // Identity admission must precede even lock creation. Repeat against selected
  // snapshots under the lock below; journal/plan reads here are read-only.
  if(command==='activate'){
    const declared=readDeployRepo(resolve(o['--repo']!),o['--agent']!).plan;
    userIdentity(declared,o['--scope']??'user');
    if(o['--runtime'])userIdentity(storedPlan(root,o['--runtime']),o['--scope']??'user');
  } else admitRollback(root,journal(root),o['--to']);
  const dry=o['--dry-run']==='true';
  let fd:number|undefined;
  if(!dry){
    admitFilesystem(root);
    const p=join(root,'activation.lock');if(exists(p))privateFile(p);
    fd=openSync(p,F.O_RDWR|F.O_CREAT|F.O_NOFOLLOW,0o600);
    if(flock(fd)!==0){closeSync(fd);refuse('E_DEPLOY_BUSY');}
  }
  try {
    const entries=journal(root),last=entries.at(-1),now=current(root);
    const systemctl=o['--systemctl']??'systemctl',timeout=Number(o['--timeout']??'30000');
    if(!Number.isSafeInteger(timeout)||timeout<1||timeout>300000)refuse('E_DEPLOY_USAGE');
    if(last?.phase==='pending'){
      if(now!==last.before?.id && now!==last.after.id && !(now===null && last.before===null))refuse('E_DEPLOY_CURRENT');
      if(command!=='rollback'||o['--to'])refuse('E_DEPLOY_RECOVERY_REQUIRED');
      admitRollback(root,entries,o['--to']);
      await restore(root,last,systemctl,timeout);return {status:'restored',warnings:persistenceWarning(last.after.scope)};
    }
    const history=effective(entries);
    let before=history.current;
    if((before?.id??null)!==now)refuse('E_DEPLOY_CURRENT');
    let after:Snapshot;
    if(command==='rollback') {
      after=admitRollback(root,entries,o['--to']).target??refuse('E_DEPLOY_ROLLBACK');
    } else {
      const repo=resolve(o['--repo']!),declared=readDeployRepo(repo,o['--agent']!).plan;
      if(declared.configuration.hold)refuse('E_DEPLOY_HOLD');
      const plan=o['--runtime']?storedPlan(root,o['--runtime']):declared;
      if(plan.agent!==declared.agent||plan.host.agentId!==declared.host.agentId||plan.host.lineage!==declared.host.lineage)refuse('E_DEPLOY_SCOPE');
      if(plan.configuration.hold)refuse('E_DEPLOY_HOLD');
      checkDeploy(plan,root);
      const mapPath=resolve(o['--credential-map']??join(root,'credential-map.json'));
      if(mapPath===repo||mapPath.startsWith(repo+'/'))refuse('E_DEPLOY_CREDENTIAL_MAP');
      const map=exists(mapPath)?object(parseJSON(readPrivate(mapPath))):{};
      if(Object.values(map).some(v=>typeof v!=='string'))refuse('E_DEPLOY_CREDENTIAL_MAP');
      const scope=o['--scope']??'user';if(scope!=='user'&&scope!=='system')refuse('E_DEPLOY_USAGE');
      after={id:planId(plan),units:renderDeployUnits(plan,root,map as Record<string,string>,scope),scope,enabled:Object.fromEntries(Object.values(plan.configuration.units).map(u=>[u.name,true])),unitDir:absolute(o['--unit-dir']??refuse('E_DEPLOY_UNIT_DIR'))};
    }
    unitDir(after.unitDir);
    if(before){const prior=command==='rollback'?storedDeclaration(root,before.id):storedPlan(root,before.id),next=storedPlan(root,after.id);if(prior.host.agentId!==next.host.agentId||prior.host.lineage!==next.host.lineage||prior.host.stateDirectory!==next.host.stateDirectory)refuse('E_DEPLOY_SCOPE');}
    if(before&&(before.scope!==after.scope||before.unitDir!==after.unitDir))refuse('E_DEPLOY_SCOPE');
    for(const name of new Set([...Object.keys(before?.units??{}),...Object.keys(after.units)])){
      const path=join(after.unitDir,name);
      if(exists(path)){if(!before?.units[name]||readPrivate(path)!==before.units[name])refuse('E_DEPLOY_UNIT_DRIFT');}
      else if(before?.units[name])refuse('E_DEPLOY_UNIT_DRIFT');
    }
    if(dry) {
      const redact=(units:Units)=>Object.fromEntries(Object.entries(units).map(([k,v])=>[k,v.replace(/^(LoadCredential=[^:]+):.*$/gm,'$1:<private>')]));
      return {current:now,next:after.id,enablement:after.enabled,warnings:persistenceWarning(after.scope),units:{before:redact(before?.units??{}),after:redact(after.units)}};
    }
    if(before)before={...before,enabled:Object.fromEntries(Object.keys(before.units).map(n=>[n,observeEnabled(systemctl,before!,n)]))};
    for(const n of Object.keys(after.units))if(!before?.units[n]&&observeEnabled(systemctl,after,n))refuse('E_DEPLOY_ENABLEMENT');
    if(canonical(before)===canonical(after))return {status:'unchanged',current:now,warnings:persistenceWarning(after.scope)};
    const entry:Entry={before,after,phase:'pending'};append(root,entry);
    try {
      if(before&&!ctl(systemctl,before.scope,'stop',Object.keys(before.units)))refuse('E_DEPLOY_SYSTEMCTL');
      disableUnits(systemctl,after,before);
      install(after,before??after);point?.('units-installed');switchCurrent(root,after.id);enableUnits(systemctl,after);
      await restart(after,systemctl,timeout);append(root,{...entry,phase:'active'});
    } catch {await restore(root,entry,systemctl,timeout);refuse('E_DEPLOY_ROLLED_BACK');}
    return {status:'active',current:after.id,warnings:persistenceWarning(after.scope)};
  } finally {if(fd!==undefined)closeSync(fd);}
}
