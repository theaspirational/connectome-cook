/** Process settings shared by source acquisition and host build tools. */
export function processAllowlistEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'CI',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** Git alone receives external authentication hooks and configuration channels. */
export function gitEnvironment(base = processAllowlistEnv()): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of [
    'SSH_AUTH_SOCK', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT',
    'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_TERMINAL_PROMPT',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'XDG_CONFIG_HOME',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Copy only indexed entries selected by COUNT; iterate present names rather
  // than an arbitrary count so malformed configuration cannot cause a long loop.
  const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  for (const key of Object.keys(process.env)) {
    const match = /^GIT_CONFIG_(?:KEY|VALUE)_(\d+)$/.exec(key);
    if (match && Number(match[1]) < count) env[key] = process.env[key];
  }
  return env;
}
