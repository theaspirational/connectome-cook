import type { InstallPlan } from './plan.js';

/** Recipe value names excluded from source-acquisition environments only. */
export function knownSecretEnvironmentNames(plan: InstallPlan): Set<string> {
  const requirements = new Set(plan.requirements.map(r => r.envName));
  return new Set([
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    ...(plan.parentWalk.recipe.services ?? []).flatMap(service => service.secrets ?? []),
    ...plan.sources.flatMap(source => source.authSecret ? [source.authSecret] : []),
    ...plan.credentialFiles.flatMap(file => file.fields.flatMap(field => field.envOverride ? [field.envOverride] : [])),
    ...plan.envVars.filter(variable => !requirements.has(variable.name)).map(variable => variable.name),
    ...Object.keys(plan.values).filter(name => !requirements.has(name)),
  ]);
}

/** Host builds receive only ordinary base settings and explicitly selected
 * parent values. Recipe declarations and resolved values do not participate. */
export function processAllowlistEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set([
    'PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'CI', 'USER', 'LOGNAME', 'SHELL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
    'PYTHON', 'PKG_CONFIG_PATH', 'CC', 'CXX', 'SSH_AUTH_SOCK',
    'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME',
    'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION',
    'npm_config_registry', 'NPM_CONFIG_REGISTRY', 'PIP_INDEX_URL', 'UV_INDEX_URL',
    'CARGO_HOME', 'RUSTUP_HOME',
  ]);
  const selected = (process.env.COOK_PASS_ENV ?? '').split(/[,\s]+/).filter(Boolean);
  if (selected.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error('COOK_PASS_ENV must contain environment variable names, not values.');
  }
  for (const key of selected) allowed.add(key);
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** Git additionally receives external authentication hooks and configuration channels. */
export function gitEnvironment(base = processAllowlistEnv(), excluded: Iterable<string> = []): NodeJS.ProcessEnv {
  const env = { ...base };
  // Explicit build opt-ins must not redirect Git repositories or bypass its
  // separate authentication/configuration policy. Re-add Git's channels below.
  for (const key of Object.keys(env)) {
    if (/^(?:GIT_|GCM_)/.test(key) || [
      'GH_TOKEN', 'GITHUB_TOKEN', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR',
      'XDG_CONFIG_HOME', 'SSH_ASKPASS', 'COOK_PASS_ENV',
    ].includes(key)) delete env[key];
  }
  for (const key of [
    'SSH_AUTH_SOCK', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT',
    'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_TERMINAL_PROMPT',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_NOSYSTEM', 'XDG_CONFIG_HOME',
    'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_SSL_CERT', 'GIT_SSL_KEY',
    'GIT_PROXY_SSL_CAINFO', 'GIT_PROXY_SSL_CAPATH', 'GIT_PROXY_SSL_CERT', 'GIT_PROXY_SSL_KEY',
    'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'GH_TOKEN', 'GITHUB_TOKEN',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Copy only indexed entries selected by COUNT; iterate present names rather
  // than an arbitrary count so malformed configuration cannot cause a long loop.
  const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GCM_')) env[key] = process.env[key];
    const match = /^GIT_CONFIG_(?:KEY|VALUE)_(\d+)$/.exec(key);
    if (match && Number(match[1]) < count) env[key] = process.env[key];
  }
  for (const key of excluded) delete env[key];
  return env;
}

/** Add a private source's credential only to this action's Git subprocesses. */
export function sourceGitEnvironment(
  url: string, authSecret: string | undefined, values: NodeJS.ProcessEnv = process.env,
  location = 'Source', base?: NodeJS.ProcessEnv, excluded: Iterable<string> = [],
): NodeJS.ProcessEnv {
  const env = gitEnvironment(base, excluded);
  if (!authSecret) return env;
  delete env[authSecret];
  const token = values[authSecret];
  if (!token) throw new Error(`${location}: missing authSecret $${authSecret}.`);
  let origin: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
    origin = parsed.origin;
  } catch {
    throw new Error(`${location}: authSecret requires an HTTP(S) source; use external Git authentication for other transports.`);
  }
  const rawCount = env.GIT_CONFIG_COUNT ?? '0';
  const count = Number(rawCount);
  if (!/^\d+$/.test(rawCount) || !Number.isSafeInteger(count) || count >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`${location}: authSecret requires a valid GIT_CONFIG_COUNT.`);
  }
  env.GIT_CONFIG_COUNT = String(count + 1);
  env[`GIT_CONFIG_KEY_${count}`] = `http.${origin}/.extraHeader`;
  env[`GIT_CONFIG_VALUE_${count}`] = `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
  return env;
}
