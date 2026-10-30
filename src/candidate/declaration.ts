import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { validateRecipe, type Recipe } from '../vendor/recipe.js';
import { inspectPlan, type InstallPlan } from '../plan.js';
import { recipeFilename, rewriteFleetRefs } from '../configuration.js';
import { collectCredentialFiles } from '../credentials.js';
import { collectRequirements, defaultEnvName } from '../requirements.js';
import { assertCredentialFreeSourceUrl } from '../source-url.js';
import { parseJSON, validate, fail, type Agent, type Declaration } from './schema.js';
import { readPrivate } from './io.js';

/** Best-effort known-field rejection, NOT a general secret scanner. */
export function nonsecret(value: unknown, key = ''): void {
  if (/^(?:api[_-]?key|authorization|password|passwd|token|secret|access[_-]?token|.*_(?:KEY|TOKEN|SECRET|PASSWORD))$/i.test(key) && !(key === 'secret' && typeof value === 'boolean') && !(typeof value === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value))) fail('E_SCOPE');
  if (typeof value === 'string') {
    if (key === 'DATA_DIR' || (key === 'dataDir' && value !== 'data')) fail('E_SCOPE');
    if (/^(?:url|repo|repository)$/i.test(key) && !value.includes('${')) { try { assertCredentialFreeSourceUrl(value); } catch { fail('E_SCOPE'); } }
  } else if (Array.isArray(value)) value.forEach(v => nonsecret(v));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) nonsecret(v, k);
}
export function singleAgent(recipe: Recipe): void {
  if (recipe.modules?.fleet) fail('E_SCOPE');
  nonsecret(recipe);
}
export async function snapshot(path: string, agent: Agent, host: Declaration['host'], seedRequired: boolean): Promise<Declaration> {
  let raw: string;
  if (/^https?:\/\//.test(path)) { assertCredentialFreeSourceUrl(path); const response = await fetch(path); if (!response.ok) fail('E_IO', 3); raw = await response.text(); }
  else raw = readFileSync(resolve(path), 'utf8');
  let recipe: Recipe;
  try { recipe = validateRecipe(parseJSON(raw)); } catch { fail('E_SCHEMA'); }
  singleAgent(recipe);
  const entry = recipeFilename(path);
  return validate('connectome.declaration/v1', { schema: 'connectome.declaration/v1', agent, entry, recipes: { [entry]: rewriteFleetRefs(recipe, path) }, host, seedRequired, dataDir: 'data' });
}
/** Only our assignment subset, never shell evaluation. Generated single-quote
 * escapes roundtrip; input files may also use simple unquoted dotenv values. */
export function parseEnv(text: string, generated = false): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^(?:export )?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) fail('E_ENV_FORMAT');
    const [, name, raw] = match;
    if (Object.hasOwn(values, name!)) fail('E_ENV_FORMAT');
    let v: string;
    if (/^'(?:[^']|'\\'')*'$/.test(raw!)) v = raw!.slice(1, -1).replace(/'\\''/g, "'");
    else if (!generated && /^[^\s'"`$\\;|&<>()[\]{}]*$/.test(raw!)) v = raw!;
    else fail('E_ENV_FORMAT');
    if (name === 'DATA_DIR') fail('E_SCOPE');
    values[name!] = v;
  }
  return values;
}
export function declarationPlan(d: Declaration, root: string, envValues: Record<string, string> = {}, sourcePath?: string): InstallPlan {
  const walks = Object.entries(d.recipes).map(([name, recipe]) => ({ path: sourcePath ?? join(root, 'recipes', name), recipe }));
  walks.sort((a, b) => (recipeFilename(a.path) === d.entry ? -1 : recipeFilename(b.path) === d.entry ? 1 : 0));
  for (const w of walks) singleAgent(w.recipe);
  let inspection: ReturnType<typeof inspectPlan>;
  try { inspection = inspectPlan(walks, true); } catch { fail('E_SCOPE'); }
  for (const source of inspection.sources) { assertCredentialFreeSourceUrl(source.url); if (source.authSecret) fail('E_SCOPE'); }
  const parentWalk = walks[0]!;
  const requirements = collectRequirements(walks).map(({ name, req, declaredIn }) => {
    const envName = req.exposeAs ?? defaultEnvName(name), value = envValues[envName];
    return { name, envName, required: req.required !== false, declaredIn, ...(value ? { value } : {}), origin: value ? 'env-file' as const : 'unresolved' as const };
  });
  const credentialFiles = collectCredentialFiles(walks);
  const credentialValues: InstallPlan['credentialValues'] = {};
  for (const spec of credentialFiles) {
    credentialValues[spec.path] = {};
    for (const f of spec.fields) if (f.envOverride && envValues[f.envOverride]) credentialValues[spec.path]![f.name] = envValues[f.envOverride]!;
  }
  return { recipePath: sourcePath ?? join(root, 'recipes', d.entry), walks, parentWalk, ...inspection,
    runtimeOnlyVars: (parentWalk.recipe.containerTemplateFiles ?? []).flatMap(t => t.runtimeVars ?? []),
    credentialFiles, credentialValues, requirements, values: { ...envValues }, envFileValues: envValues, options: { strict: true, noPrompts: true, fileOnly: true } };
}
export const loadPrivateEnv = (path: string): Record<string, string> => parseEnv(readPrivate(path));
