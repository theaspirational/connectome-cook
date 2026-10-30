import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { processAllowlistEnv } from '../process-env.js';
import { validateLock } from './lockfile.js';
import { lowerToConfiguration, recipeFilename } from '../configuration.js';
import { generateOverlays } from '../generators/overlay.js';
import { hostPathFor } from '../backends/host.js';
import { deriveRequiredVars } from '../prompts.js';
import { renderRuntimeFiles } from '../backends/runtime-files.js';
import { withoutLogs } from '../log.js';
import { canonical, CandidateError, fail, hash, issue, parseJSON, report, type Declaration, type Envelope, type Finding, type Findings, type Hold, type Check } from './schema.js';
import { exists, noLinks, privateDir, privateFile, readPrivate, readRecord } from './io.js';
import { declarationPlan, parseEnv } from './declaration.js';
import { inspectSeed } from './seed.js';
import type { InstallPlan } from '../plan.js';

export function safeGitHead(path: string): string {
  const env = { ...processAllowlistEnv(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const p = spawnSync('git', ['-c', 'core.fsmonitor=', 'rev-parse', 'HEAD'], { cwd: path, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  if (p.status !== 0 || !/^[0-9a-f]{40,64}$/.test(p.stdout.trim())) fail('E_PIN_INCOMPLETE');
  return p.stdout.trim();
}
function internal(root: string, path: string): string {
  const rel = relative(root, resolve(path));
  if (!rel || rel === '..' || rel.startsWith('../')) fail('E_PATH');
  noLinks(path); return rel;
}
/** All independent checks run; missing dependencies get their own findings.
 * This function has no admission/adapter execution, network or write path. */
export function verify(root: string): Findings {
  root = resolve(root);
  const findings: Finding[] = [];
  const add = (code: string, check: Check, subject: string, message?: string) => findings.push(issue(code, check, subject, message));
  const check = <T>(group: Check, subject: string, fn: () => T): T | undefined => {
    try { return withoutLogs(fn); }
    catch (e) { add(e instanceof CandidateError ? e.code : (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'E_PATH' : 'E_IO', group, subject); return undefined; }
  };
  check('envelope', '.', () => privateDir(root));
  check('envelope', '.cook', () => privateDir(join(root, '.cook')));
  const envelope: Envelope | undefined = check('envelope', 'connectome.deployment.json', () => readRecord(root, 'connectome.deployment.json', 'connectome.deployment/v1'));
  const hold: Hold | undefined = check('hold', '.cook/hold.json', () => readRecord(root, '.cook/hold.json', 'connectome.hold/v1'));
  const declaration: Declaration | undefined = check('declaration', '.cook/declaration.json', () => readRecord(root, '.cook/declaration.json', 'connectome.declaration/v1'));
  const lock = check('materialization', 'connectome.lock', () => validateLock(parseJSON(readPrivate(join(root, 'connectome.lock')))));
  check('envelope', '.cook/operation.lock', () => privateFile(join(root, '.cook/operation.lock')));
  if (!envelope && !hold) add('W_LEGACY_UNMANAGED', 'envelope', '.', 'No managed candidate identity is established.');
  if (hold) {
    add('I_HELD', 'hold', '.cook/hold.json', 'Disposable candidate is held; activation is not allowed.');
    if (envelope && canonical(hold.agent) !== canonical(envelope.agent)) add('E_IDENTITY', 'hold', '.cook/hold.json');
  }
  if (envelope && declaration) {
    if (canonical(envelope.agent) !== canonical(declaration.agent)) add('E_IDENTITY', 'declaration', '.cook/declaration.json');
    if (hash(canonical(declaration)) !== envelope.desired.configDigest) add('E_DIGEST', 'declaration', '.cook/declaration.json');
  }
  if (envelope) check('materialization', 'connectome.lock', () => { if (hash(readPrivate(join(root, 'connectome.lock'))) !== envelope.materialized.lockDigest) fail('E_DIGEST'); });
  check('hold', 'run.sh', () => {
    privateFile(join(root, 'run.sh'), 0o700);
    if (!readFileSync(join(root, 'run.sh'), 'utf8').includes('connectome.candidate-launcher/v1')) fail('E_SCOPE');
  });
  if (lock) {
    check('materialization', 'launch', () => { if (lock.launch.kind !== 'script' || resolve(lock.launch.script) !== join(root, 'run.sh')) fail('E_PATH'); });
    const components = [{ path: lock.connectomeHost.path!, commit: lock.connectomeHost.commit, id: 'app' }, ...lock.components.map((c, i) => ({ path: c.path, commit: c.commit, id: `component-${i + 1}` }))];
    for (const c of components) check('materialization', c.id, () => {
      internal(root, c.path);
      if (!lstatSync(c.path).isDirectory()) fail('E_PATH');
      if (!c.commit) fail('E_PIN_INCOMPLETE');
      if (safeGitHead(c.path) !== c.commit) fail('E_CONFIG_DRIFT');
    });
    check('materialization', 'app/src/index.ts', () => { internal(root, join(root, 'app/src/index.ts')); if (!lstatSync(join(root, 'app/src/index.ts')).isFile()) fail('E_PATH'); });
    for (let i = 0; i < lock.localExtensions.length; i++) check('materialization', `local-extension-${i + 1}`, () => { internal(root, lock.localExtensions[i]!.path); fail('E_PROOF_INCOMPLETE'); });
  }
  let plan: InstallPlan | undefined;
  if (declaration) plan = check('declaration', 'recipes', () => declarationPlan(declaration, root));
  else add('E_PROOF_INCOMPLETE', 'declaration', 'recipes', 'Declaration checks require a valid frozen snapshot.');
  let values: Record<string, string> = {};
  if (check('credentials', '.env', () => exists(join(root, '.env')))) values = check('credentials', '.env', () => parseEnv(readPrivate(join(root, '.env')), true)) ?? {};
  if (plan) {
    const required = deriveRequiredVars(plan.envVars.filter(v => !plan!.runtimeOnlyVars.includes(v.name)), plan.sources, (plan.parentWalk.recipe.services ?? []).flatMap(s => s.secrets ?? []), plan.walks);
    const missingNames = new Set<string>();
    for (const [index, v] of required.entries()) if (v.defaultValue === undefined && ![v.name, ...(v.altNames ?? [])].some(n => values[n])) {
      missingNames.add(v.name); add('W_CREDENTIAL_MISSING', 'credentials', `variable-${index + 1}`, 'Required private value is missing; no credential was tested.');
    }
    for (const [index, spec] of plan.credentialFiles.entries()) check('credentials', `credential-file-${index + 1}`, () => {
      const path = resolve(root, 'app', spec.path);
      if (!exists(path)) { add('W_CREDENTIAL_MISSING', 'credentials', `credential-file-${index + 1}`); return; }
      noLinks(path); privateFile(path);
    });
    for (const [index, name] of (plan.parentWalk.recipe.services ?? []).flatMap(s => s.secrets ?? []).entries()) check('credentials', `sidecar-secret-${index + 1}`, () => {
      const path = resolve(root, name); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail('E_PATH'); if (!exists(path)) { add('W_CREDENTIAL_MISSING', 'credentials', `sidecar-secret-${index + 1}`); return; } privateFile(path);
    });
    if (plan.walks.some(w => w.recipe.agent.provider === 'openai-codex')) add('W_CREDENTIAL_MISSING', 'credentials', 'provider', 'Provider login and executable prerequisites cannot be qualified offline.');
    for (const [index, req] of plan.requirements.entries()) check('requirements', `requirement-${index + 1}`, () => {
      const answer = lock?.requirements.find(r => r.name === req.name && r.envName === req.envName)?.value;
      if (req.required && (!answer || !existsSync(answer))) fail('E_REQUIREMENT_MISSING');
      if (!lock) fail('E_PROOF_INCOMPLETE');
    });
    for (const [index, source] of plan.sources.entries()) check('materialization', `source-${index + 1}`, () => {
      const component = lock?.components.find(c => c.key === source.key);
      if (!component || source.install.kind === 'npm-global') fail('E_PIN_INCOMPLETE');
      if (component.url !== source.url || component.ref !== source.ref || component.path !== hostPathFor(root, source.inContainerPath)) fail('E_CONFIG_DRIFT');
    });
    if (lock) check('configuration', 'recipes', () => {
      const overlays = generateOverlays({ walks: plan!.walks, sources: plan!.sources.filter(s => s.install.kind !== 'npm-global').map(s => ({ ...s, inContainerPath: hostPathFor(root, s.inContainerPath) })), localExtensions: plan!.localExtensions.map(e => ({ ...e, inContainerPath: lock.localExtensions.find(l => l.name === e.name)?.hostDir ?? e.hostDir })), envVars: plan!.envVars, options: { outDir: root, noPrompts: true, strict: true, pinRefs: false } });
      for (const w of plan!.walks) check('configuration', `recipes/${recipeFilename(w.path)}`, () => {
        const path = join(root, 'recipes', recipeFilename(w.path)); noLinks(path);
        const actual = parseJSON(readFileSync(path, 'utf8'));
        const expected = lowerToConfiguration(w.recipe, overlays.get(w.path), w.path);
        if (canonical(actual) !== canonical(expected)) add('E_CONFIG_DRIFT', 'configuration', `recipes/${recipeFilename(w.path)}`);
        for (const [i, ext] of Object.values(expected.extensions ?? {}).entries()) check('materialization', `extension-entry-${i + 1}`, () => {
          const path = resolve(root, 'app', ext.path); noLinks(path);
          if (!lstatSync(path).isFile()) fail('E_PATH');
          if (!path.startsWith(root + '/')) fail('E_PROOF_INCOMPLETE');
        });
        for (const [i, server] of Object.values(expected.mcpServers ?? {}).entries()) check('materialization', `mcp-entry-${i + 1}`, () => {
          if (!server.command) return; // Remote consumer is covered by handshake evidence.
          let checked = false;
          if (server.command.includes('/')) { const path = resolve(root, 'app', server.command); internal(root, path); if (!lstatSync(path).isFile()) fail('E_PATH'); checked = true; }
          const first = server.args?.[0];
          if (first && !first.startsWith('-') && (first.includes('/') || /\.(?:m?js|ts|py)$/.test(first))) { const path = resolve(root, 'app', first); internal(root, path); if (!lstatSync(path).isFile()) fail('E_PATH'); checked = true; }
          if (!checked) fail('E_PROOF_INCOMPLETE');
        });
      });
    });
    else add('E_PROOF_INCOMPLETE', 'configuration', 'recipes', 'Configuration comparison requires a structurally valid lock.');
    const rendered = check('configuration', 'templates', () => renderRuntimeFiles(plan!, values));
    for (const [index, t] of (rendered ?? []).entries()) check('configuration', `template-${index + 1}`, () => {
      if (t.missing.length) {
        add(t.missing.every(n => missingNames.has(n)) ? 'W_CREDENTIAL_MISSING' : 'E_CONFIG_DRIFT', 'configuration', `template-${index + 1}`, 'Template inputs are incomplete.');
        return;
      }
      if (t.runtime) { add('E_PROOF_INCOMPLETE', 'configuration', `template-${index + 1}`, 'Runtime placeholders are unresolved; no sidecar was started.'); return; }
      const path = t.kind === 'sidecar-template' ? resolve(root, t.relPath) : hostPathFor(root, t.inContainer!);
      internal(root, path);
      if (readFileSync(path, 'utf8') !== t.content) fail('E_CONFIG_DRIFT');
    });
  } else {
    for (const group of ['configuration', 'requirements', 'credentials', 'handshakes'] as const) add('E_PROOF_INCOMPLETE', group, 'declaration', 'This check requires a valid inspected declaration.');
  }
  if (declaration) {
    for (const [i, recipe] of Object.values(declaration.recipes).entries()) {
      for (const [j] of Object.values(recipe.mcpServers ?? {}).entries()) add('E_HANDSHAKE_MISSING', 'handshakes', `recipe-${i + 1}/mcp-${j + 1}`, 'No qualified tuple-bound MCP handshake receipt is available.');
      for (const [j] of (recipe.services ?? []).entries()) add('E_HANDSHAKE_MISSING', 'handshakes', `recipe-${i + 1}/sidecar-${j + 1}`, 'No qualified tuple-bound sidecar handshake receipt is available.');
    }
  }
  if (envelope && declaration && hold) check('seed', 'data', () => {
    privateDir(join(root, 'data'));
    add(inspectSeed(root, { envelope, declaration, hold }), 'seed', 'data', 'Seed evidence checked; this is not activation permission.');
  });
  else add('E_INGEST_MISSING', 'seed', 'data', 'Seed bindings require envelope, declaration and hold.');
  add('E_PROOF_INCOMPLETE', 'deferred', '.', 'Unit binding, executable closure, effective gates and running observation are not qualified in PR01b.');
  return report('verify', hold ? true : envelope ? true : null, findings);
}
