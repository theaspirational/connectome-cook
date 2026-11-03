import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDeployRepo, secretFree } from './deploy-repo.js';
const roots: string[] = [];
export function fixture() {
  const root = mkdtempSync(join(tmpdir(),'cook-deploy-')); roots.push(root);
  const dir = join(root,'agents','fixture'); mkdirSync(dir,{recursive:true});
  const write = (file:string,value:unknown) => writeFileSync(join(root,file),JSON.stringify(value));
  const agent = { host:'fixture', user:'fixture',hold:false,layout:'legacy-support-agents',paths:{},release:'fixture',units:{main:{name:'fixture.service',exec_start:['/bin/false'],unit:{},service:{},environment:{},install:{}}},credentials:[],seed_settings:null,versions:{} };
  write('versions.yml',{runtime:'a'.repeat(40),slack:'base'});
  write('agents/fixture/agent.yml',agent);
  write('agents/fixture/recipe.json',{name:'fixture',version:'1.0.0',agent:{name:'fixture',provider:'anthropic',model:'fixture'}});
  return {root,dir,write,agent};
}
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
test('fleet pins, per-agent precedence, source and missing build inputs',()=>{
  const f=fixture(); f.write('agents/fixture/agent.yml',{...f.agent,versions:{slack:'override'}});
  const {plan}=readDeployRepo(f.root,'fixture');
  expect(plan.effectivePins.slack).toEqual({value:'override',source:'override'});
  expect(plan.effectivePins.runtime?.source).toBe('base');
  expect(plan.missing).toContain('chRef'); expect(plan.recipeDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
});
test('host existing options resolve explicit pin placeholders',()=>{
  const f=fixture(); f.write('agents/fixture/host.yml',{chRef:'{runtime}',hostDependencies:[]});
  expect(readDeployRepo(f.root,'fixture').plan.host.chRef).toBe('a'.repeat(40));
});
test('unknown keys and undeclared overrides refuse',()=>{
  for(const [file,value] of [['versions.yml',{unknown:'pin'}],['agents/fixture/host.yml',{exec:'echo no'}]] as const){
    const f=fixture();f.write(file,value);expect(()=>readDeployRepo(f.root,'fixture')).toThrow();
  }
  const f=fixture();f.write('agents/fixture/agent.yml',{...f.agent,versions:{telegram:'unknown'}});
  expect(()=>readDeployRepo(f.root,'fixture')).toThrow();
  f.write('agents/fixture/agent.yml',{...f.agent,units:{main:{...f.agent.units.main,unexpected:true}}});
  expect(()=>readDeployRepo(f.root,'fixture')).toThrow();
});
test('duplicate escaped JSON keys and path traversal refuse',()=>{
  const f=fixture(); writeFileSync(join(f.root,'versions.yml'),'{"runtime":"x","runt\\u0069me":"y"}');
  expect(()=>readDeployRepo(f.root,'fixture')).toThrow();
  expect(()=>readDeployRepo(f.root,'../fixture')).toThrow();
});
test('secret-like literals, escaped keys, nested sensitive values refuse without echo',()=>{
  for(const value of [{token:'private-literal'},{token:12},{token:{nested:['private-literal']}},{x:'ghp_FAKE_PAYLOAD'},{x:'a'.repeat(64)}]){
    expect(()=>secretFree(value)).toThrow('E_DEPLOY_SECRET');
  }
  expect(()=>secretFree({token:'${TOKEN}'})).not.toThrow();
  const f=fixture();f.write('agents/fixture/recipe.json',{name:'fixture',token:'private-literal'});
  expect(()=>readDeployRepo(f.root,'fixture')).toThrow('E_DEPLOY_SECRET');
});
