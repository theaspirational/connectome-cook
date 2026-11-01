import { candidateGitEnvironment } from '../process-env.js';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { runHostBackend, DEFAULT_CH_REF, DEFAULT_CH_REPO_URL } from '../backends/host.js';
import { withoutLogs } from '../log.js';
import { pinSources, resolveRemoteRef } from '../pin-refs.js';
import { canonical, hash, fail, validate, type Agent, type Envelope } from './schema.js';
import { guard, publish, readPrivate, reserve } from './io.js';
import { declarationPlan, loadPrivateEnv, snapshot } from './declaration.js';

export interface PrepareOptions { root: string; recipe: string; agent: Agent; seedRequired: boolean; envFile?: string; hostUrl?: string; hostRef?: string; pinRefs?: boolean; allowIncompleteTemplates?: boolean }
export async function prepare(options: PrepareOptions): Promise<Envelope> {
  const root = resolve(options.root);
  guard(root);
  if (process.env.DATA_DIR !== undefined) fail('E_SCOPE');
  // Platform/lock admission and ownership precede all recipe/secret/tool reads.
  const release = reserve(root);
  try {
    const hold = validate('connectome.hold/v1', { schema: 'connectome.hold/v1', agent: options.agent, state: 'held', scope: 'disposable-candidate', reason: 'candidate-preparation', createdAt: new Date().toISOString() });
    publish(join(root, '.cook/hold.json'), canonical(hold));
    const host = { url: options.hostUrl ?? DEFAULT_CH_REPO_URL, ref: options.hostRef ?? DEFAULT_CH_REF };
    const declaration = await snapshot(options.recipe, options.agent, host, options.seedRequired);
    const env = options.envFile ? loadPrivateEnv(resolve(options.envFile)) : {};
    const plan = withoutLogs(() => declarationPlan(declaration, root, env, /^https?:\/\//.test(options.recipe) ? options.recipe : resolve(options.recipe)));
    if (plan.requirements.some(r => r.required && (!r.value || !existsSync(r.value)))) fail('E_REQUIREMENT_MISSING');
    publish(join(root, '.cook/declaration.json'), canonical(declaration));
    let chCommit: string | undefined;
    const result = await withoutLogs(async () => {
      if (options.pinRefs) { pinSources(plan.sources, candidateGitEnvironment()); chCommit = resolveRemoteRef(host.url, host.ref, candidateGitEnvironment()) ?? undefined; if (!chCommit) fail('E_PIN_INCOMPLETE'); }
      return runHostBackend(plan, { installDir: root, chRepoUrl: host.url, chRef: host.ref, chCommit, noPrompts: true, yes: true, candidate: true, allowIncompleteTemplates: options.allowIncompleteTemplates ?? false });
    });
    if (result.exitCode) fail(result.exitCode === 3 ? 'E_IO' : 'E_CONFIG_DRIFT', result.exitCode);
    const envelope = validate('connectome.deployment/v1', { schema: 'connectome.deployment/v1', agent: options.agent, desired: { declaration: '.cook/declaration.json', configDigest: hash(canonical(declaration)) }, materialized: { lock: 'connectome.lock', lockVersion: 1, lockDigest: hash(readPrivate(join(root, 'connectome.lock'))) }, installed: null, running: null, lifecycle: 'held-candidate' });
    publish(join(root, 'connectome.deployment.json'), canonical(envelope));
    return envelope;
  } finally { release(); }
}
