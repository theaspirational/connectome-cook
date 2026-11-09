import { execFileSync } from 'node:child_process';

/** Keep user configuration/PATH, but never let an enclosing repository redirect
 * commands intended for an explicitly acquired checkout or scratch store. */
export function repositoryIndependentGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const localVars = execFileSync('git', ['rev-parse', '--local-env-vars'], {
    env, timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const name of localVars.trim().split(/\s+/)) delete env[name];
  return env;
}
