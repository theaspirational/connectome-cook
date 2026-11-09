/**
 * Docker backend — materializes an InstallPlan as the classic cook artifact
 * bundle: Dockerfile, docker-compose.yml, .env(.example), README,
 * entrypoint, credential/secret files, rendered templates, bundled local
 * extensions, and the lowered configurations under recipes/.
 *
 * Interaction policy: the plan already collected every operator value; the
 * only prompt here is the final confirm-before-write gate (skipped under
 * --no-prompts).
 */

import { basename, dirname, join, resolve, sep } from 'node:path';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { log } from '../log.js';
import { escapeForEnvFile } from '../env-encoding.js';
import type { BuildOptions, GeneratorInput } from '../types.js';
import type { Recipe } from '../vendor/recipe.js';
import type { InstallPlan } from '../plan.js';
import { generateDockerfile } from '../generators/dockerfile.js';
import { generateCompose } from '../generators/compose.js';
import { generateOverlays } from '../generators/overlay.js';
import { generateEnv } from '../generators/env.js';
import { generateReadme } from '../generators/readme.js';
import { generateEntrypoint } from '../generators/entrypoint.js';
import { confirmWrite } from '../prompts.js';
import { hostFilename, serializeCredentialFile } from '../credentials.js';
import { lowerToConfiguration, recipeFilename } from '../configuration.js';
import { DEFAULT_CH_REF, DEFAULT_CH_REPO_URL } from '../generators/dockerfile.js';
import {
  createOutputHasher, deploymentRecord, fullCommit, outputRecords, resolveNpmComponents,
  writeLockfile, type LockfileV2, type PublicOutputDigest,
} from '../lockfile.js';
import {
  buildValueBag,
  collectSidecarSecretFiles,
  enforceCompleteTemplates,
  renderRuntimeFiles,
} from './runtime-files.js';

export interface DockerBackendOptions extends BuildOptions {
  /** Write templated config files even when `${VAR}` references render
   *  empty (default: refuse the build). */
  allowIncompleteTemplates: boolean;
}

/** Result of the docker backend (used by both build and run handlers). */
export interface BuildResult {
  exitCode: number;
  outDir: string;
}

/** Render a `.env` file body from collected key/value pairs.  Sorted by
 *  key for determinism; each line `KEY=value` with a trailing newline.
 *  Values are quoted/escaped per `escapeForEnvFile` so compose's
 *  interpolation doesn't misread `${...}` substrings inside tokens. */
function renderEnvFile(values: Record<string, string>): string {
  const keys = Object.keys(values).sort();
  return keys.map((k) => `${k}=${escapeForEnvFile(values[k]!)}`).join('\n')
    + (keys.length ? '\n' : '');
}

/** Materialize the plan into `options.outDir`. */
export async function runDockerBackend(
  plan: InstallPlan,
  options: DockerBackendOptions,
): Promise<BuildResult> {
  const {
    walks,
    sources,
    localExtensions,
    envVars,
    credentialFiles,
    values: collectedValues,
    credentialValues,
  } = plan;
  const outDir = options.outDir;
  // v2 must never claim a symbolic ref is an immutable pin.
  let chCommit: string | undefined;
  let npmComponents: ReturnType<typeof resolveNpmComponents>;
  try {
    chCommit = options.pinnedChRef === undefined ? undefined : fullCommit(options.pinnedChRef, 'connectome-host');
    for (const s of sources) {
      if (s.install.kind !== 'sibling-copy' && s.install.kind !== 'npm-global' && s.commit !== undefined) {
        fullCommit(s.commit, s.key);
      }
    }
    npmComponents = resolveNpmComponents(sources);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 2, outDir };
  }
  const input: GeneratorInput = { walks, sources, localExtensions, envVars, options };

  log.step(`generating artifacts → ${log.dim(outDir)}`);
  let dockerfile: string;
  let compose: string;
  let envExample: string;
  let readme: string;
  let entrypoint: string;
  let overlays: Map<string, Partial<Recipe>>;
  try {
    dockerfile = generateDockerfile(input);
    compose = generateCompose(input);
    envExample = generateEnv(input);
    readme = generateReadme(input);
    entrypoint = generateEntrypoint(input);
    overlays = generateOverlays(input);
  } catch (err) {
    log.error(`generator failed: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 2, outDir };
  }

  const recipesOut = walks.map((walk) => ({
    filename: recipeFilename(walk.path),
    content: JSON.stringify(
      lowerToConfiguration(walk.recipe, overlays.get(walk.path), walk.path),
      null,
      2,
    ) + '\n',
  }));

  // Compose always references .env. Create an empty file when absent,
  // preserving an operator-owned file when no values were collected.
  const writeEnvFile = Object.keys(collectedValues).length > 0
    || !existsSync(join(outDir, '.env'));

  // Credential files we have AT LEAST ONE value for; complete-skip files
  // get omitted so the operator notices via the warn rather than getting
  // a half-empty .zuliprc that fails confusingly at runtime.
  const credFilesToWrite = credentialFiles.filter((cf) =>
    Object.keys(credentialValues[cf.path] ?? {}).length === cf.fields.length,
  );
  const credFilesPartial = credentialFiles.filter((cf) => {
    const got = Object.keys(credentialValues[cf.path] ?? {}).length;
    return got > 0 && got < cf.fields.length;
  });
  for (const cf of credFilesPartial) {
    log.warn(
      `${cf.path}: only partial values supplied (${Object.keys(credentialValues[cf.path] ?? {}).length}/${cf.fields.length}) — file skipped`,
    );
  }

  // BuildKit secret files: one per unique authSecret across sources.
  // The compose `secrets:` block expects each token in `<outDir>/<NAME>`.
  // We've already collected the values via prompts/env-file/process.env
  // (authSecrets dedupe with same-named recipe vars in deriveRequiredVars),
  // so cook just writes them out — no extra operator step.
  const authSecretFiles: Array<{ name: string; value: string }> = [];
  const seenAuthSecrets = new Set<string>();
  const missingAuthSecrets: string[] = [];
  for (const src of sources) {
    if (!src.authSecret || seenAuthSecrets.has(src.authSecret)) continue;
    seenAuthSecrets.add(src.authSecret);
    const value = collectedValues[src.authSecret];
    if (value !== undefined && value !== '') {
      authSecretFiles.push({ name: src.authSecret, value });
    } else {
      missingAuthSecrets.push(src.authSecret);
    }
  }
  for (const name of missingAuthSecrets) {
    log.warn(
      `build secret ${name}: no value supplied — file skipped (operator must \`echo ... > ${outDir}/${name} && chmod 600 ${name}\` before \`docker compose build\`)`,
    );
  }

  // Sidecar runtime secrets.  Sidecars are folded into the plan's prompt
  // pipeline (see resolvePlan), so by this point any value the operator was
  // going to supply is already in collectedValues.  Deduped against
  // build-time authSecrets — same name, same file.
  const sidecarSecretFiles = collectSidecarSecretFiles(
    plan,
    seenAuthSecrets,
    `operator must hand-place the file (mode 0600) in ${outDir} before \`docker compose up\``,
  );

  // Templated config files (sidecar `templateFiles[]` + top-level
  // `containerTemplateFiles[]`) — assembly shared with the host backend.
  // Docker placement: `<outDir>/<relPath>`, with runtime-rendered files as
  // `<relPath>.tmpl` for the image entrypoint's start-time envsubst.
  const valueBag = buildValueBag(plan);
  const runtimeFiles = renderRuntimeFiles(plan, valueBag);
  const renderedTemplates = runtimeFiles.map((f) => ({
    path: f.runtime ? `${f.relPath}.tmpl` : f.relPath,
    content: f.content,
    mode: f.mode,
    missing: f.missing,
    origin: f.origin,
  }));

  if (!enforceCompleteTemplates(runtimeFiles, options.allowIncompleteTemplates)) {
    return { exitCode: 2, outDir };
  }

  // +1 for connectome.lock.
  const fileCount = 6
    + recipesOut.length
    + (writeEnvFile ? 1 : 0)
    + credFilesToWrite.length
    + authSecretFiles.length
    + sidecarSecretFiles.length
    + renderedTemplates.length
    + localExtensions.length;

  // Confirm-before-write gate.  Skipped in --no-prompts mode (the operator
  // told us to be non-interactive; bombing into a confirm prompt would
  // defeat the flag's purpose).
  if (!options.noPrompts) {
    const ok = await confirmWrite(outDir, fileCount);
    if (!ok) {
      log.warn('cancelled by user');
      return { exitCode: 1, outDir };
    }
  }

  // Capture public provenance from generated bytes, before each write. Never
  // read outputs back: an output directory can contain links or change later.
  const hashOutput = createOutputHasher(plan.requirements);
  const publicOutputs = new Map<string, PublicOutputDigest>();
  const writePublic = (path: string, content: string, mode?: number) => {
    publicOutputs.set(path, hashOutput(content));
    writeFileSync(join(outDir, path), content, { mode });
  };
  try {
    mkdirSync(outDir, { recursive: true });
    mkdirSync(join(outDir, 'recipes'), { recursive: true });
    writePublic('Dockerfile', dockerfile);
    writePublic('docker-compose.yml', compose);
    writePublic('.env.example', envExample);
    writePublic('README.md', readme);
    writePublic('entrypoint.sh', entrypoint, 0o755);
    if (writeEnvFile) {
      writeFileSync(join(outDir, '.env'), renderEnvFile(collectedValues));
    }
    for (const cf of credFilesToWrite) {
      const filename = hostFilename(cf);
      const content = serializeCredentialFile(cf, credentialValues[cf.path] ?? {});
      const mode = cf.mode ? parseInt(cf.mode, 8) : 0o600;
      writeFileSync(join(outDir, filename), content, { mode });
    }
    for (const sec of authSecretFiles) {
      // BuildKit reads the file content verbatim as the secret value —
      // no quoting, no trailing newline (some tools care).
      writeFileSync(join(outDir, sec.name), sec.value, { mode: 0o600 });
    }
    for (const sec of sidecarSecretFiles) {
      // Same file shape as build-time secrets; docker secrets reads
      // the file content as the secret value.
      writeFileSync(join(outDir, sec.name), sec.value, { mode: 0o600 });
    }
    for (const tf of renderedTemplates) {
      const fullPath = join(outDir, tf.path);
      // Defense-in-depth: validator already rejects paths with `..` /
      // leading `/`, but a future change could regress.  Verify the
      // resolved path stays inside outDir before writing.
      const resolvedFull = resolve(fullPath);
      const resolvedOut = resolve(outDir);
      if (resolvedFull !== resolvedOut && !resolvedFull.startsWith(resolvedOut + sep)) {
        throw new Error(
          `templateFile path "${tf.path}" resolves outside outDir (${resolvedFull} vs ${resolvedOut}) — refusing to write`,
        );
      }
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, tf.content, { mode: tf.mode });
    }
    for (const { filename, content } of recipesOut) {
      writePublic(`recipes/${filename}`, content);
    }
    // Local extension bundles: copy the entry file's directory from the
    // operator's disk into the build context. node_modules and .git are
    // excluded — the image resolves deps against /app/node_modules (plus a
    // fresh `bun install` when the bundle carries a package.json).
    for (const ext of localExtensions) {
      const target = join(outDir, 'extensions', ext.name);
      rmSync(target, { recursive: true, force: true });
      // Guard against hostDir containing outDir (entry file next to the
      // recipe in cwd + default ./<slug>-cook): copying a directory into
      // its own subtree throws, and even elsewhere, generated .env/secret
      // files must never be swept into the build context.
      const resolvedOutDir = resolve(outDir);
      cpSync(ext.hostDir, target, {
        recursive: true,
        filter: (src) => {
          const base = basename(src);
          if (base === 'node_modules' || base === '.git') return false;
          const resolvedSrc = resolve(src);
          return resolvedSrc !== resolvedOutDir
            && !resolvedSrc.startsWith(resolvedOutDir + sep);
        },
      });
    }

    const connectomeHost = { url: DEFAULT_CH_REPO_URL, ref: DEFAULT_CH_REF, ...(chCommit !== undefined ? { commit: chCommit } : {}) };
    const components: LockfileV2['components'] = [
      ...sources.filter(s => s.install.kind !== 'sibling-copy' && s.install.kind !== 'npm-global').map(s => ({
        kind: 'git' as const, key: s.key, role: s.role ?? 'mcp', url: s.url, ref: s.ref,
        path: s.inContainerPath, install: s.install.kind,
        ...(s.commit !== undefined ? { commit: fullCommit(s.commit, s.key) } : {}),
      })),
      ...npmComponents,
    ];
    const lock: LockfileV2 = {
      version: 2,
      backend: 'docker',
      recipePath: plan.recipePath,
      createdAt: new Date().toISOString(),
      connectomeHost, components,
      ...deploymentRecord(plan, 'docker', outDir, connectomeHost, components, {
        strict: options.strict, imageName: options.imageName,
        allowIncompleteTemplates: options.allowIncompleteTemplates,
      }),
      localExtensions: localExtensions.map(ext => ({
        name: ext.name, hostDir: ext.hostDir, path: `${ext.inContainerPath}/${ext.entryBasename}`,
      })),
      outputs: outputRecords(outDir, publicOutputs, [
        ...credFilesToWrite.map(hostFilename), ...authSecretFiles.map(s => s.name),
        ...sidecarSecretFiles.map(s => s.name), ...renderedTemplates.map(f => f.path),
      ]),
      launch: { kind: 'compose', dir: outDir },
    };
    writeLockfile(outDir, lock);
  } catch (err) {
    log.error(`write failed: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 3, outDir };
  }

  const overlayCount = Array.from(overlays.values()).length;
  log.success(`wrote ${fileCount} files to ${outDir}`);
  if (overlayCount > 0) {
    log.info(log.dim(`    (${overlayCount} recipe${overlayCount === 1 ? '' : 's'} have overlays applied)`));
  }
  return { exitCode: 0, outDir };
}
