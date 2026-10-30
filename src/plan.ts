/**
 * Install-plan resolution — the backend-agnostic front half of cook.
 *
 * `resolvePlan` walks the recipe tree, detects every component that must
 * exist for the deployment to run (MCP sources, extensions), collects the
 * environment/credential values the operator must supply (env-file >
 * process.env > interactive prompts), and returns the whole thing as an
 * `InstallPlan`.
 *
 * Backends consume the plan and materialize it:
 *   - docker backend (backends/docker.ts): the classic artifact bundle —
 *     Dockerfile + compose + .env + configurations.
 *   - host backend (backends/host.ts): clone/build onto the operator's
 *     machine, launcher script, lockfile.
 *
 * The plan is where interaction lives; backends should not prompt (except
 * their own final confirm-before-write gates).
 */

import { resolve } from 'node:path';
import { log } from './log.js';
import type {
  EnvVar,
  LocalExtension,
  McpSource,
  WalkResult,
} from './types.js';
import { walkRecipe } from './walker.js';
import { detectRecipeFilenameCollisions } from './configuration.js';
import { detectSources } from './source-detector.js';
import { detectExtensions } from './extension-detector.js';
import { collectEnvVars } from './env-collector.js';
import {
  deriveRequiredVars,
  loadEnvFile,
  promptForVars,
  promptForCredentialFields,
  resolvePresent,
  type CredentialFileField,
} from './prompts.js';
import {
  collectCredentialFiles,
  resolveFieldValue,
  type CredentialFileSpec,
} from './credentials.js';
import {
  enforceRequirements,
  resolveRequirements,
  type ResolvedRequirement,
} from './requirements.js';

export interface PlanOptions {
  /** Candidate-only: never consult ambient secrets. */
  fileOnly?: boolean;
  /** Fail on any MCP server / extension cook can't bake. */
  strict: boolean;
  /** Non-interactive: warn-and-continue on missing values. */
  noPrompts: boolean;
  /** Optional dotenv-shaped file consulted before process.env and prompts. */
  envFile?: string;
}

/** Everything a backend needs to materialize a deployment. */
export interface InstallPlan {
  /** The recipe path/URL the operator named. */
  recipePath: string;
  /** Walker output: parent first, then descendants in declaration order. */
  walks: WalkResult[];
  /** walks[0], for convenient access. */
  parentWalk: WalkResult;
  /** MCP sources + git-sourced extensions (role 'extension'). */
  sources: McpSource[];
  /** Source-less extensions bundled from the operator's disk. */
  localExtensions: LocalExtension[];
  /** Every `${VAR}` referenced in the walked recipes (incl. runtime-only). */
  envVars: EnvVar[];
  /** Vars filled at container start by the entrypoint — not operator-supplied. */
  runtimeOnlyVars: string[];
  /** Credential-file specs collected across the tree. */
  credentialFiles: CredentialFileSpec[];
  /** Resolved host-machine discovery requirements (values also merged into
   *  `values` under their exposeAs names). */
  requirements: ResolvedRequirement[];
  /** Resolved operator values (env-file > process.env > prompts). */
  values: Record<string, string>;
  /** Raw values from --env-file (kept separate: template rendering gives
   *  them precedence over process.env, unlike prompt values). */
  envFileValues: Record<string, string>;
  /** Per-credential-file field values, keyed by the file's declared path. */
  credentialValues: Record<string, Record<string, string>>;
  /** Options the plan was resolved under. */
  options: PlanOptions;
}

export type PlanResult =
  | { ok: true; plan: InstallPlan }
  | { ok: false; exitCode: number };

/**
 * Resolve a recipe into an InstallPlan. Interactive unless opts.noPrompts.
 * Returns a failure exit code (with the error already logged) instead of
 * throwing — the CLI maps it straight to process exit.
 */
export async function resolvePlan(
  recipePath: string,
  opts: PlanOptions,
): Promise<PlanResult> {
  let walks: WalkResult[];
  try {
    log.step(`walking recipe ${log.dim(recipePath)}`);
    walks = await walkRecipe(recipePath);
    log.success(`loaded ${walks.length} recipe${walks.length === 1 ? '' : 's'}`);
  } catch (err) {
    log.error(`failed to load recipe: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, exitCode: 2 };
  }

  const parentWalk = walks[0];
  if (!parentWalk) {
    log.error('walker returned no recipes — internal error');
    return { ok: false, exitCode: 2 };
  }

  if (walks.some((walk) => walk.recipe.agent.provider === 'openai-codex')) {
    log.warn(
      'Codex inference requires a codex executable on PATH, writable persistent CODEX_HOME, ' +
      'and codex login in the runtime environment. Cook does not supply these prerequisites.',
    );
  }

  let inspection: ReturnType<typeof inspectPlan>;
  try { inspection = inspectPlan(walks, opts.strict); }
  catch (err) { log.error(err instanceof Error ? err.message : String(err)); return { ok: false, exitCode: 2 }; }
  const { sources, localExtensions, envVars } = inspection;

  // Resolve required env values.  Precedence: --env-file > process.env > prompts.
  // (Single source-of-truth — see prompts.ts::resolveValue.)
  // Sidecar runtime secrets get folded into the same prompt list so the
  // operator gets ONE coherent UX rather than discovering them via warns.
  const sidecarSecretNames = Array.from(new Set(
    (parentWalk.recipe.services ?? []).flatMap((svc) => svc.secrets ?? []),
  ));
  // Exclude `runtimeVars` declared on containerTemplateFiles — these are
  // filled at container start by the conhost entrypoint (from a bootstrap
  // sidecar's output, an exec hook, etc.) and should NOT show up in the
  // operator's .env.example or interactive prompt list.
  const runtimeOnlyVars = new Set<string>(
    (parentWalk.recipe.containerTemplateFiles ?? [])
      .flatMap((tf) => tf.runtimeVars ?? []),
  );
  const envVarsForOperator = envVars.filter((v) => !runtimeOnlyVars.has(v.name));
  const required = deriveRequiredVars(envVarsForOperator, sources, sidecarSecretNames, walks);
  let envFileValues: Record<string, string> = {};
  if (opts.envFile) {
    try {
      envFileValues = loadEnvFile(resolve(opts.envFile));
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      return { ok: false, exitCode: 1 };
    }
  }
  // Host-machine discovery (`requirements` block): probe candidate paths,
  // confirm with the operator, expose answers as env vars. Resolved BEFORE
  // the generic var prompt so a requirement that is also referenced as a
  // recipe `${VAR}` is asked exactly once — the requirement prompt (which
  // knows how to probe) wins.
  let requirements: ResolvedRequirement[];
  try {
    const reqResult = await resolveRequirements(walks, {
      noPrompts: opts.noPrompts,
      envFileValues,
    });
    if (reqResult.cancelled) {
      log.warn('cancelled by user');
      return { ok: false, exitCode: 1 };
    }
    requirements = reqResult.resolved;
    enforceRequirements(requirements);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return { ok: false, exitCode: 2 };
  }
  const requirementValues: Record<string, string> = {};
  for (const r of requirements) {
    if (r.value !== undefined) requirementValues[r.envName] = r.value;
  }

  const { found, missing: missingRaw } = resolvePresent(required, envFileValues);
  const missing = missingRaw.filter((v) => requirementValues[v.name] === undefined);
  let collectedValues: Record<string, string> = { ...requirementValues, ...found };
  if (missing.length > 0) {
    if (opts.noPrompts) {
      log.warn(
        `--no-prompts: ${missing.length} required value${missing.length === 1 ? '' : 's'} ` +
        `still missing — operator must supply them before the deployment can run`,
      );
    } else {
      const result = await promptForVars(missing);
      if (result.cancelled) {
        log.warn('cancelled by user');
        return { ok: false, exitCode: 1 };
      }
      collectedValues = { ...collectedValues, ...result.values };
    }
  }

  // Credential files: walk the recipe tree, resolve each field via env
  // override, then prompt for the rest (or warn under --no-prompts).
  const credentialFiles = collectCredentialFiles(walks);
  const credentialValues: Record<string, Record<string, string>> = {};
  const missingCredFields: CredentialFileField[] = [];
  for (const cf of credentialFiles) {
    credentialValues[cf.path] = {};
    for (const field of cf.fields) {
      const val = resolveFieldValue(field, envFileValues);
      if (val !== undefined) {
        credentialValues[cf.path]![field.name] = val;
      } else {
        missingCredFields.push({
          filePath: cf.path,
          fieldName: field.name,
          envOverride: field.envOverride,
          description: field.description,
          placeholder: field.placeholder,
          secret: field.secret,
        });
      }
    }
  }
  if (missingCredFields.length > 0) {
    if (opts.noPrompts) {
      log.warn(
        `--no-prompts: ${missingCredFields.length} credential-file field${missingCredFields.length === 1 ? '' : 's'} ` +
        `unset — files will be skipped (operator must hand-place them before the deployment can run)`,
      );
    } else {
      const result = await promptForCredentialFields(missingCredFields);
      if (result.cancelled) {
        log.warn('cancelled by user');
        return { ok: false, exitCode: 1 };
      }
      for (const [path, fields] of Object.entries(result.values)) {
        credentialValues[path] = { ...(credentialValues[path] ?? {}), ...fields };
      }
    }
  }

  return {
    ok: true,
    plan: {
      recipePath,
      walks,
      parentWalk,
      sources,
      localExtensions,
      envVars,
      runtimeOnlyVars: Array.from(runtimeOnlyVars),
      credentialFiles,
      requirements,
      values: collectedValues,
      envFileValues,
      credentialValues,
      options: opts,
    },
  };
}

/** Pure declaration inspection shared by legacy resolution and offline candidate
 * verification. No fetches, probes, credential reads or prompts. */
export function inspectPlan(walks: WalkResult[], strict: boolean): {
  sources: McpSource[]; localExtensions: LocalExtension[]; envVars: EnvVar[];
} {
  if (!walks[0]) throw new Error('No recipes');
  const collisions = detectRecipeFilenameCollisions(walks.map(w => w.path));
  if (collisions.size) throw new Error('recipe filename collision: rename colliding recipes before materialization');
  for (const child of walks.slice(1)) {
    if (child.recipe.services?.length) throw new Error('child recipe declares services; move them to the parent recipe');
    if (child.recipe.containerTemplateFiles?.length) throw new Error('child recipe declares containerTemplateFiles; move them to the parent recipe');
  }
  const sources = detectSources(walks, { strict });
  const extensions = detectExtensions(walks, { strict });
  return { sources: [...sources, ...extensions.gitExtensions], localExtensions: extensions.localExtensions, envVars: collectEnvVars(walks) };
}
