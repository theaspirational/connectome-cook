import { activationCommand } from './deploy-activate.js';
import { checkDeploy, stageDeploy } from './deploy-stage.js';
import { resolve } from 'node:path';
import { canonical } from './candidate/schema.js';
import { readDeployRepo, refuse } from './deploy-repo.js';
export async function deployCommand(args: string[]): Promise<number> {
  if (args.length===1 && ['--help','-h'].includes(args[0]!)) {
    process.stdout.write('cook deploy plan --repo DIR --agent SLUG\ncook deploy stage|check --repo DIR --agent SLUG --root DIR\ncook deploy activate --repo DIR --agent SLUG --root DIR --unit-dir DIR [--scope user|system] [--credential-map FILE] [--runtime ID] [--dry-run]\ncook deploy rollback --root DIR [--to ID] [--systemctl COMMAND]\ncook deploy status --root DIR\n'); return 0;
  }
  try {
    const command=args[0]; if(!['plan','stage','check','activate','rollback','status'].includes(command??''))refuse('E_DEPLOY_USAGE');
    const options: Record<string,string>={};
    for(let i=1;i<args.length;i+=2){const k=args[i]!;if(k==='--dry-run'&&command==='activate'){if(options[k])refuse('E_DEPLOY_USAGE');options[k]='true';i--;continue;}const v=args[i+1];if(!['--repo','--agent','--root',...(command==='activate'?['--runtime','--credential-map','--unit-dir','--scope','--systemctl','--timeout']:command==='rollback'?['--to','--systemctl','--timeout']:[])].includes(k)||!v||v.startsWith('--')||Object.hasOwn(options,k))refuse('E_DEPLOY_USAGE');options[k]=v;}
    if(['activate','rollback','status'].includes(command!)){
      if(!options['--root']||(command==='activate'&&(!options['--repo']||!options['--agent'])))refuse('E_DEPLOY_USAGE');
      process.stdout.write(canonical(await activationCommand(command!,options))+'\n');return 0;
    }
    if(!options['--repo']||!options['--agent']||(command==='plan'?options['--root']!==undefined:!options['--root']))refuse('E_DEPLOY_USAGE');
    const {plan}=readDeployRepo(resolve(options['--repo']!),options['--agent']!);
    if(command==='plan'){process.stdout.write(canonical(plan)+'\n');return 0;}
    if(plan.missing.length){process.stderr.write('E_DEPLOY_MISSING: '+plan.missing.join(', ')+'\n');return 2;}
    const candidate=command==='stage'?stageDeploy(resolve(options['--repo']!),options['--agent']!,resolve(options['--root']!)):checkDeploy(plan,resolve(options['--root']!));
    process.stdout.write(canonical({candidate,status:'ok',activated:false,held:false})+'\n');return 0;
  } catch(error) {
    const code=error instanceof Error && /^E_DEPLOY_[A-Z_]+$/.test(error.message)?error.message:'E_DEPLOY_REFUSED';
    process.stderr.write(code+': deploy refused.\n');return 2;
  }
}
