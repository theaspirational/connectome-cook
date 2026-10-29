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
import { gitEnvironment } from './process-env.js';
import { assertCredentialFreeSourceUrl } from './source-url.js';
import { log } from './log.js';
import type { McpSource } from './types.js';

/** 40-char (or abbreviated 7+) hex string — already a commit, nothing to do. */
export function looksLikeSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(ref);
}

/** Candidate remote ref names to try for a symbolic ref, in order. */
export function candidateRefNames(ref: string): string[] {
  if (ref.startsWith('refs/')) return [ref];
  return [`refs/heads/${ref}`, `refs/tags/${ref}`, ref];
}

/**
 * Resolve `ref` on `url` to a commit SHA via `git ls-remote`.
 * Returns null when the remote is unreachable or the ref doesn't exist.
 */
export function resolveRemoteRef(url: string, ref: string): string | null {
  assertCredentialFreeSourceUrl(url);
  if (looksLikeSha(ref)) return ref;
  for (const candidate of candidateRefNames(ref)) {
    let output: string;
    try {
      output = execFileSync('git', ['ls-remote', url, candidate], {
        encoding: 'utf-8',
        env: gitEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
    } catch {
      return null; // Remote unreachable — retrying other candidates won't help.
    }
    const sha = output.split('\n')[0]?.split('\t')[0]?.trim();
    if (sha && looksLikeSha(sha)) return sha;
  }
  return null;
}

/**
 * Pin every git source in place (sets `source.commit`). Skips registry,
 * sibling-copy, and already-pinned entries. Private symbolic refs are
 * refused: pinning has no safe authSecret handoff.
 */
export function pinSources(sources: McpSource[]): void {
  for (const source of sources) {
    assertCredentialFreeSourceUrl(source.url);
    if (!source.url || source.commit) continue;
    if (source.install.kind === 'npm-global' || source.install.kind === 'sibling-copy') continue;
    if (looksLikeSha(source.ref)) {
      source.commit = source.ref;
      continue;
    }
    if (source.authSecret) {
      throw new Error('--pin-refs: cannot resolve private refs with authSecret; supply a commit SHA.');
    }
    const sha = resolveRemoteRef(source.url, source.ref);
    if (sha) {
      source.commit = sha;
      log.info(`--pin-refs: ${log.dim(source.url)}@${source.ref} → ${sha.slice(0, 12)}`);
    } else {
      throw new Error(`--pin-refs: could not resolve ${source.url}@${source.ref}; no output written.`);
    }
  }
}
