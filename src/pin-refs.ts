/**
 * --pin-refs: resolve branch/tag refs to commit SHAs at cook time.
 *
 * Pinning turns "whatever the branch tip is when the image builds" into a
 * reproducible build: the SHA is baked into clone/checkout commands and
 * recorded in connectome.lock. Resolution uses `git ls-remote` — network
 * access at cook time, none at build time beyond the clones themselves.
 *
 * Failure policy: fail closed. An unresolved requested pin aborts before
 * any backend materializes the plan.
 */

import { execFileSync } from 'node:child_process';
import { sourceGitEnvironment } from './process-env.js';
import { assertCredentialFreeSourceUrl, sourceLocation } from './source-url.js';
import { log } from './log.js';
import type { McpSource } from './types.js';

/** Only full SHA-1 or SHA-256 object IDs are trusted without remote lookup. */
export function looksLikeSha(ref: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(ref);
}

/** Candidate remote ref names to try for a symbolic ref, in order. */
export function candidateRefNames(ref: string): string[] {
  if (ref.startsWith('refs/')) return [ref];
  return [`refs/heads/${ref}`, `refs/tags/${ref}`, ref];
}

/**
 * Resolve `ref` on `url` to a commit SHA via `git ls-remote`.
 * Returns null if no candidate ref exists; throws with diagnostics on remote failure.
 */
export function resolveRemoteRef(
  url: string, ref: string, sslBypass = false, location = 'Source URL',
  authSecret?: string, values?: NodeJS.ProcessEnv, excluded?: Iterable<string>,
): string | null {
  assertCredentialFreeSourceUrl(url, location);
  if (looksLikeSha(ref)) return ref.toLowerCase();
  const env = sourceGitEnvironment(url, authSecret, values, location, undefined, excluded);
  for (const candidate of candidateRefNames(ref)) {
    const args = [...(sslBypass ? ['-c', 'http.sslVerify=false'] : []), 'ls-remote', url, candidate];
    let output: string;
    try {
      output = execFileSync('git', args, {
        encoding: 'utf-8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
    } catch (err) {
      // Helper output and the execFileSync message may contain credentials.
      // Report only spawn metadata, never stderr/stdout or the original error.
      const { code, signal, status } = err as { code?: string; signal?: string; status?: number };
      const outcome = code === 'ENOENT' ? 'git executable not found (ENOENT)'
        : code === 'ETIMEDOUT' || signal ? 'git ls-remote timed out or was terminated'
        : typeof status === 'number' ? `git ls-remote exit ${status}`
        : 'git ls-remote could not start or complete';
      // Quote argv for a POSIX shell so even local paths and unusual refs can be
      // copied literally. The URL has already passed credential validation.
      const command = ['git', ...args].map(arg => /^[a-z0-9_./:@=+-]+$/i.test(arg)
        ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
      throw new Error(`--pin-refs: ${location}: could not resolve ${url}@${ref}: remote unreachable or refused (${outcome}); no output written. run \`${command}\` to see Git's diagnostics.`);
    }
    const sha = output.split('\n')[0]?.split('\t')[0]?.trim();
    if (sha && looksLikeSha(sha)) return sha;
  }
  if (/^[0-9a-f]{7,39}$/i.test(ref)) {
    throw new Error(`--pin-refs: ${location}: '${ref}' looks like an abbreviated commit ID; --pin-refs needs the full 40-hex ID (git rev-parse ${ref}); no output written.`);
  }
  return null;
}

/**
 * Pin every git source in place (sets `source.commit`). Skips registry,
 * sibling-copy, and already-pinned entries. Private symbolic refs use
 * the same environment-only authSecret channel as host acquisition.
 */
export function pinSources(
  sources: McpSource[], values?: NodeJS.ProcessEnv,
  excluded: Iterable<string> = sources.flatMap(source => source.authSecret ? [source.authSecret] : []),
): void {
  for (const source of sources) {
    const location = sourceLocation(source);
    assertCredentialFreeSourceUrl(source.url, `${location}.url`);
    if (!source.url || source.commit) continue;
    if (source.install.kind === 'npm-global' || source.install.kind === 'sibling-copy') continue;
    if (looksLikeSha(source.ref)) {
      source.commit = source.ref.toLowerCase();
      continue;
    }
    const sha = resolveRemoteRef(source.url, source.ref, source.sslBypass, location, source.authSecret, values, excluded);
    if (sha) {
      source.commit = sha;
      log.info(`--pin-refs: ${log.dim(source.url)}@${source.ref} → ${sha.slice(0, 12)}`);
    } else {
      throw new Error(`--pin-refs: ${location}: ref not found: ${source.url}@${source.ref}; no output written.`);
    }
  }
}
