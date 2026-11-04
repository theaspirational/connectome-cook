import { renderDeployUnits } from './deploy-activate.js';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { readDeployRepo } from './deploy-repo.js';
import { planId, stageDeploy } from './deploy-stage.js';
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
  write(join(repo,'agents/fixture/agent.yml'),{host:'fixture',user:userInfo().username,hold:false,layout:'legacy-support-agents',paths:{},release:'fixture',units:{main:{name:'fixture.service',exec_start:['/bin/false'],unit:{},service:{},environment:{},install:{WantedBy:'default.target'}}},credentials:[],seed_settings:null,versions:{}});
  write(join(repo,'agents/fixture/recipe.json'),{name:'Fixture',agent:{systemPrompt:'Fixture'}});
  const node=join(dir,'node');writeFileSync(node,'#!/bin/sh\necho v22.23.3\n');chmodSync(node,0o755);
  write(join(repo,'agents/fixture/host.yml'),{chRepo:source,chRef:'{runtime}',bunPath:process.execPath,nodePath:node,hostDependencies:[`fixture-dependency=${archive}#sha256=${sha}`],userUnit:'fixture.service',agentId:'01234567-89ab-cdef-0123-456789abcdef',lineage:'abcdef01-2345-6789-abcd-ef0123456789',stateDirectory:join(dir,'state')});
});
beforeEach(()=>{
  mkdirSync(join(dir,'state'));mkdirSync(join(dir,'units'),{mode:0o700});
  mkdirSync(join(dir,'enabled'));
  writeFileSync(join(dir,'systemctl'),`#!/bin/sh
echo "$@" >> "${join(dir,'calls')}"
verb="$2"; shift 2
case "$verb" in
is-enabled) if [ -e "${join(dir,'enabled')}/$1" ]; then echo enabled; exit 0; else echo disabled; exit 1; fi;;
enable) if [ -e "${join(dir,'enable-failed')}" ]; then rm "${join(dir,'enable-failed')}"; exit 1; fi; for n in "$@"; do touch "${join(dir,'enabled')}/\${n##*/}"; done;;
disable) for n in "$@"; do rm -f "${join(dir,'enabled')}/\${n##*/}"; done;;
is-active) if [ -e "${join(dir,'failed')}" ]; then rm "${join(dir,'failed')}"; exit 1; fi;;
esac
exit 0
`,{mode:0o700});
});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
function plan(){return readDeployRepo(repo,'fixture').plan;}
function cli(command:string, extra:string[]=[]){return spawnSync(process.execPath,[resolve('bin/cook'),'deploy',command,'--repo',repo,'--agent','fixture',...extra],{encoding:'utf8'});}

function activate(extra:string[]=[]){return cli('activate',['--root',root,'--unit-dir',join(dir,'units'),'--systemctl',join(dir,'systemctl'),...extra]);}
function rollback(extra:string[]=[]){return spawnSync(process.execPath,[resolve('bin/cook'),'deploy','rollback','--root',root,'--systemctl',join(dir,'systemctl'),...extra],{encoding:'utf8'});}
function change(){const p=join(repo,'agents/fixture/recipe.json');write(p,{name:'Fixture',agent:{systemPrompt:'Next'}});stageDeploy(repo,'fixture',root);return planId(plan());}
test('CLI fresh activate, idempotence, new runtime and rollback',()=>{
  stageDeploy(repo,'fixture',root);const first=planId(plan());
  const a=activate();expect(a.stderr).toBe('');expect(a.status).toBe(0);
  expect(readlinkSync(join(root,'current'))).toBe('runtimes/'+first);
  const journal=readFileSync(join(root,'activation.jsonl'),'utf8'),calls=readFileSync(join(dir,'calls'),'utf8');
  expect(activate().status).toBe(0);expect(readFileSync(join(root,'activation.jsonl'),'utf8')).toBe(journal);expect(readFileSync(join(dir,'calls'),'utf8')).toBe(calls+'--user is-enabled fixture.service\n');
  const next=change();expect(activate().status).toBe(0);expect(readlinkSync(join(root,'current'))).toBe('runtimes/'+next);
  expect(rollback().status).toBe(0);expect(readlinkSync(join(root,'current'))).toBe('runtimes/'+first);
  const status=cli('status',['--root',root]);expect(status.status).toBe(0);expect(JSON.parse(status.stdout).current).toBe(first);
});
test('CLI failed health automatically restores previous runtime and units',()=>{
  stageDeploy(repo,'fixture',root);expect(activate().status).toBe(0);const first=readlinkSync(join(root,'current')),unit=readFileSync(join(dir,'units/fixture.service'),'utf8');
  change();writeFileSync(join(dir,'failed'),'');
  const r=activate(['--timeout','1']);expect(r.stderr).toContain('E_DEPLOY_ROLLED_BACK');
  expect(readlinkSync(join(root,'current'))).toBe(first);expect(readFileSync(join(dir,'units/fixture.service'),'utf8')).toBe(unit);
});
test('CLI credentials are names and paths only; unreadable payload is untouched',()=>{
  const file=join(repo,'agents/fixture/agent.yml'),a=JSON.parse(readFileSync(file,'utf8'));
  a.credentials=[{name:'auth',deliver:'systemd-credential',consumer:'main'}];write(file,a);
  stageDeploy(repo,'fixture',root);expect(activate().stderr).toContain('E_DEPLOY_CREDENTIAL_MAP');
  const sentinel=join(dir,'credential');writeFileSync(sentinel,'SYNTHETIC_SENTINEL_NEVER_READ',{mode:0});
  writeFileSync(join(root,'credential-map.json'),JSON.stringify({auth:sentinel}),{mode:0o600});
  const dry=activate(['--dry-run']);expect(dry.status).toBe(0);expect(dry.stdout).not.toContain(sentinel);expect(dry.stdout).toContain('auth');
  const result=activate();expect(result.status).toBe(0);
  for(const s of [result.stdout,readFileSync(join(root,'activation.jsonl'),'utf8'),readFileSync(join(dir,'units/fixture.service'),'utf8')])expect(s).not.toContain('SYNTHETIC_SENTINEL');
});
test('CLI hold, drift, unwritable unit dir and dry run refuse writes',()=>{
  stageDeploy(repo,'fixture',root);const entries=readdirSync(root);
  expect(activate(['--dry-run']).status).toBe(0);expect(readdirSync(root)).toEqual(entries);expect(readdirSync(join(dir,'units'))).toEqual([]);expect(existsSync(join(dir,'calls'))).toBe(false);
  chmodSync(join(dir,'units'),0o500);expect(activate().status).not.toBe(0);chmodSync(join(dir,'units'),0o700);
  const file=join(repo,'agents/fixture/agent.yml'),a=JSON.parse(readFileSync(file,'utf8'));a.hold=true;write(file,a);
  expect(activate().stderr).toContain('E_DEPLOY_HOLD');expect(existsSync(join(root,'current'))).toBe(false);
});
test('unit rendering golden and scope',()=>{
  const p=plan();
  expect(renderDeployUnits(p,root,{},'user')['fixture.service']).toBe([
    '[Unit]','','[Service]','Restart=on-failure','Type=simple',
    'WorkingDirectory='+join(dir,'state'),'ExecStart="/bin/false"','','[Install]','WantedBy=default.target',''
  ].join('\n'));
  expect(renderDeployUnits(p,root,{},'system')['fixture.service']).toContain('User='+userInfo().username+'\n');
  p.configuration.units.side={...p.configuration.units.main!,name:'side.service'};
  expect(Object.keys(renderDeployUnits(p,root,{},'user'))).toEqual(['fixture.service','side.service']);
});
test('crash after unit publication before current switch requires explicit rollback recovery',()=>{
  stageDeploy(repo,'fixture',root);
  const script=join(dir,'crash.ts');
  writeFileSync(script,`import {activationCommand} from ${JSON.stringify(resolve('src/deploy-activate.ts'))};
    await activationCommand('activate',${JSON.stringify({'--root':root,'--repo':repo,'--agent':'fixture','--unit-dir':join(dir,'units'),'--systemctl':join(dir,'systemctl')})},()=>process.exit(77));`);
  expect(spawnSync(process.execPath,[script]).status).toBe(77);
  expect(existsSync(join(root,'current'))).toBe(false);expect(existsSync(join(dir,'units/fixture.service'))).toBe(true);
  expect(activate().stderr).toContain('E_DEPLOY_RECOVERY_REQUIRED');
  expect(rollback().status).toBe(0);
  expect(existsSync(join(dir,'units/fixture.service'))).toBe(false);
  expect(activate().status).toBe(0);
});
test('concurrent CLI activation refuses a held root lock',()=>{
  stageDeploy(repo,'fixture',root);
  const fdScript=join(dir,'lock.ts');
  writeFileSync(fdScript,`import {openSync} from 'node:fs';import {flock} from ${JSON.stringify(resolve('src/candidate/io.ts'))};
    const fd=openSync(${JSON.stringify(join(root,'activation.lock'))},'wx',0o600);
    if(flock(fd)!==0)process.exit(3);
    const r=Bun.spawnSync([${JSON.stringify(process.execPath)},${JSON.stringify(resolve('bin/cook'))},'deploy','activate','--repo',${JSON.stringify(repo)},'--agent','fixture','--root',${JSON.stringify(root)},'--unit-dir',${JSON.stringify(join(dir,'units'))},'--systemctl',${JSON.stringify(join(dir,'systemctl'))}]);
    process.stdout.write(r.stderr);process.exit(r.exitCode);`);
  const r=spawnSync(process.execPath,[fdScript],{encoding:'utf8'});
  expect(r.status).toBe(2);expect(r.stdout).toContain('E_DEPLOY_BUSY');expect(existsSync(join(root,'current'))).toBe(false);
});
test('unknown credential mappings, private-map mode, staged drift and unit drift refuse',()=>{
  stageDeploy(repo,'fixture',root);
  writeFileSync(join(root,'credential-map.json'),JSON.stringify({unknown:'/not/opened'}),{mode:0o600});
  expect(activate().stderr).toContain('E_DEPLOY_CREDENTIAL_MAP');
  writeFileSync(join(root,'credential-map.json'),'{}');chmodSync(join(root,'credential-map.json'),0o644);
  expect(activate().status).toBe(2);chmodSync(join(root,'credential-map.json'),0o600);
  expect(activate().status).toBe(0);
  writeFileSync(join(dir,'units/fixture.service'),'foreign');
  expect(activate().stderr).toContain('E_DEPLOY_UNIT_DRIFT');
  writeFileSync(join(root,'.builds',planId(plan()),'runtime/app/src/index.ts'),'drift');
  expect(activate().status).toBe(2);
});
test('CLI system scope, named rollback and explicit older runtime',()=>{
  stageDeploy(repo,'fixture',root);const first=planId(plan());
  expect(activate(['--scope','system']).status).toBe(0);
  const second=change();expect(activate(['--scope','system']).status).toBe(0);
  expect(rollback(['--to',first]).status).toBe(0);
  expect(activate(['--scope','system','--runtime',second]).status).toBe(0);
  expect(activate(['--scope','system','--runtime',first]).status).toBe(0);
  expect(readFileSync(join(dir,'calls'),'utf8')).toContain('--system restart fixture.service');
});
function third(){
  write(join(repo,'agents/fixture/recipe.json'),{name:'Fixture',agent:{systemPrompt:'Third'}});
  stageDeploy(repo,'fixture',root);
}
function crashActivation(){
  const script=join(dir,'crash-later.ts');
  writeFileSync(script,`import {activationCommand} from ${JSON.stringify(resolve('src/deploy-activate.ts'))};
    await activationCommand('activate',${JSON.stringify({'--root':root,'--repo':repo,'--agent':'fixture','--unit-dir':join(dir,'units'),'--systemctl':join(dir,'systemctl')})},()=>process.exit(77));`);
  expect(spawnSync(process.execPath,[script]).status).toBe(77);
}
test('CLI refuses mismatched account and unsupported group before any writes',()=>{
  const file=join(repo,'agents/fixture/agent.yml'),a=JSON.parse(readFileSync(file,'utf8'));
  a.user=process.getuid?.()===0?'nobody':'root';write(file,a);stageDeploy(repo,'fixture',root);
  const entries=readdirSync(root);
  expect(activate().stderr).toContain('E_DEPLOY_IDENTITY');
  expect(readdirSync(root)).toEqual(entries);expect(readdirSync(join(dir,'units'))).toEqual([]);
  expect(existsSync(join(dir,'calls'))).toBe(false);
  a.user=userInfo().username;a.units.main.service.Group='unsupported-group';write(file,a);
  expect(activate().stderr).toContain('E_DEPLOY_IDENTITY');expect(readdirSync(root)).toEqual(entries);
});
for(const failure of ['health','crash'] as const)test('CLI effective predecessor survives third '+failure+' failure and recovery',()=>{
  stageDeploy(repo,'fixture',root);const a=planId(plan());expect(activate().status).toBe(0);
  const b=change();expect(activate().status).toBe(0);third();
  if(failure==='health'){
    writeFileSync(join(dir,'failed'),'');expect(activate(['--timeout','1']).stderr).toContain('E_DEPLOY_ROLLED_BACK');
  }else{
    crashActivation();expect(rollback().status).toBe(0);
  }
  const status=JSON.parse(cli('status',['--root',root]).stdout);
  expect(status.current).toBe(b);expect(status.previous).toBe(a);
  expect(existsSync(join(dir,'enabled/fixture.service'))).toBe(true);
  expect(rollback().status).toBe(0);expect(readlinkSync(join(root,'current'))).toBe('runtimes/'+a);
});
for(const scope of ['user','system'])test('CLI transactional enablement and prior disabled-state rollback: '+scope,()=>{
  stageDeploy(repo,'fixture',root);
  const result=activate(['--scope',scope]);expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).warnings.length).toBe(scope==='user'?1:0);
  expect(result.stdout.includes('linger')).toBe(scope==='user');
  expect(existsSync(join(dir,'enabled/fixture.service'))).toBe(true);
  // Operator disabled the predecessor; the next transition must snapshot that.
  rmSync(join(dir,'enabled/fixture.service'));
  change();expect(activate(['--scope',scope]).status).toBe(0);
  expect(existsSync(join(dir,'enabled/fixture.service'))).toBe(true);
  expect(rollback().status).toBe(0);expect(existsSync(join(dir,'enabled/fixture.service'))).toBe(false);
  const calls=readFileSync(join(dir,'calls'),'utf8');
  expect(calls).toContain('--'+scope+' enable '+join(dir,'units/fixture.service'));
  expect(calls).toContain('--'+scope+' disable fixture.service');
  expect(calls).not.toContain('enable-linger');
});
test('CLI failed enablement rolls back and crash recovery preserves prior disabled state',()=>{
  stageDeploy(repo,'fixture',root);expect(activate().status).toBe(0);
  rmSync(join(dir,'enabled/fixture.service'));change();writeFileSync(join(dir,'enable-failed'),'');
  expect(activate().stderr).toContain('E_DEPLOY_ROLLED_BACK');expect(existsSync(join(dir,'enabled/fixture.service'))).toBe(false);
  crashActivation();expect(rollback().status).toBe(0);expect(existsSync(join(dir,'enabled/fixture.service'))).toBe(false);
});
test('CLI golden argv escaping and LoadCredential; disallowed directives refuse',()=>{
  const file=join(repo,'agents/fixture/agent.yml'),a=JSON.parse(readFileSync(file,'utf8'));
  a.units.main.exec_start=['/bin/echo','$cash','%specifier','"double"',"'single'",'back\\slash'];
  a.credentials=[{name:'auth',deliver:'systemd-credential',consumer:'main'}];write(file,a);
  stageDeploy(repo,'fixture',root);
  const credential=join(dir,'never-opened');
  writeFileSync(join(root,'credential-map.json'),JSON.stringify({auth:credential}),{mode:0o600});
  expect(activate().status).toBe(0);
  expect(readFileSync(join(dir,'units/fixture.service'),'utf8')).toBe([
    '[Unit]','','[Service]','Restart=on-failure','Type=simple','WorkingDirectory='+join(dir,'state'),
    String.raw`ExecStart="/bin/echo" "$$cash" "%%specifier" "\"double\"" "'single'" "back\\slash"`,
    'LoadCredential=auth:'+credential,'','[Install]','WantedBy=default.target',''
  ].join('\n'));
  const journal=readFileSync(join(root,'activation.jsonl'),'utf8');
  a.units.main.service.ExecStop='/bin/false';write(file,a);
  expect(activate().stderr).toContain('E_DEPLOY_SCHEMA');
  expect(readFileSync(join(root,'activation.jsonl'),'utf8')).toBe(journal);
});
test('CLI fresh failed health removes all attempted sidecar enablement',()=>{
  const file=join(repo,'agents/fixture/agent.yml'),a=JSON.parse(readFileSync(file,'utf8'));
  a.units.side={...a.units.main,name:'side.service'};write(file,a);stageDeploy(repo,'fixture',root);
  writeFileSync(join(dir,'failed'),'');
  expect(activate(['--timeout','1']).stderr).toContain('E_DEPLOY_ROLLED_BACK');
  expect(readdirSync(join(dir,'enabled'))).toEqual([]);
  expect(readdirSync(join(dir,'units'))).toEqual([]);
  expect(existsSync(join(root,'current'))).toBe(false);
});

test('rollback remains possible when abandoned failed candidate is corrupt',()=>{
 stageDeploy(repo,'fixture',root);const a=planId(plan());expect(activate().status).toBe(0);
 change();expect(activate().status).toBe(0);third();const failed=planId(plan());
 writeFileSync(join(dir,'failed'),'');expect(activate(['--timeout','1']).status).toBe(2);
 writeFileSync(join(root,'.builds',failed,'runtime/app/src/index.ts'),'corrupt abandoned candidate');
 const r=rollback();
 expect(r.status).toBe(0);expect(readlinkSync(join(root,'current'))).toBe('runtimes/'+a);
});
test('pending recovery does not need abandoned failed candidate integrity',()=>{
 stageDeploy(repo,'fixture',root);const a=planId(plan());expect(activate().status).toBe(0);
 change();crashActivation();const failed=planId(plan());
 writeFileSync(join(root,'.builds',failed,'runtime/app/src/index.ts'),'corrupt abandoned candidate');
 const r=rollback();
 expect(r.status).toBe(0);expect(readlinkSync(join(root,'current'))).toBe('runtimes/'+a);
});
test('CLI rollback does not require integrity of the runtime being replaced',()=>{
  stageDeploy(repo,'fixture',root);const a=planId(plan());expect(activate().status).toBe(0);
  const b=change();expect(activate().status).toBe(0);
  writeFileSync(join(root,'.builds',b,'runtime/app/src/index.ts'),'corrupt current code');
  expect(rollback().status).toBe(0);
  expect(readlinkSync(join(root,'current'))).toBe('runtimes/'+a);
});
for(const pending of [false,true])test('CLI '+(pending?'recovery':'rollback')+' checks restore target before even lock creation',()=>{
  stageDeploy(repo,'fixture',root);const a=planId(plan());expect(activate().status).toBe(0);
  change();if(pending)crashActivation();else expect(activate().status).toBe(0);
  writeFileSync(join(root,'.builds',a,'runtime/app/src/index.ts'),'corrupt restore target');
  // No operation remains alive; removal makes a premature lock write observable.
  rmSync(join(root,'activation.lock'));
  const entries=readdirSync(root),journal=readFileSync(join(root,'activation.jsonl'),'utf8');
  const calls=readFileSync(join(dir,'calls'),'utf8'),unit=readFileSync(join(dir,'units/fixture.service'),'utf8');
  expect(rollback().stderr).toContain('E_DEPLOY_TREE_DRIFT');
  expect(readdirSync(root)).toEqual(entries);
  expect(readFileSync(join(root,'activation.jsonl'),'utf8')).toBe(journal);
  expect(readFileSync(join(dir,'calls'),'utf8')).toBe(calls);
  expect(readFileSync(join(dir,'units/fixture.service'),'utf8')).toBe(unit);
});
