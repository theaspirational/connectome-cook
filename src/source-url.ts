import type { McpSource } from './types.js';

/** Reject inline credentials before a source URL can reach logs, git, or artifacts. */
export function assertCredentialFreeSourceUrl(url: string, location = 'Source URL'): void {
  const credentialError = () => new Error(`${location}: embedded credentials are not allowed.`);
  // URL() silently trims whitespace and removes some controls. Reject the raw
  // spelling first, before parsing, logging, or passing it to another tool.
  if (url !== url.trim() || /[\x00-\x1f\x7f]/.test(url)) {
    throw new Error(`${location}: source URLs must not contain surrounding whitespace or ASCII controls.`);
  }
  if (url.startsWith('//')) {
    throw new Error(`${location}: protocol-relative source URLs are not supported; use an explicit scheme.`);
  }
  const checkUsername = (value: string) => {
    let username: string;
    try {
      username = decodeURIComponent(value);
    } catch {
      throw new Error(`${location}: invalid source URL; use a URL without embedded credentials.`);
    }
    const tokenPrefix = /(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-)/i;
    const tokenUser = /^(?:oauth2|x-access-token|x-token-auth)$/i;
    // A strict allowlist avoids Unicode normalization and invisible-character
    // bypasses. Do not echo the rejected username: it may contain a secret.
    if (!/^[A-Za-z0-9._-]+$/.test(username)) {
      throw new Error(`${location}: embedded credentials are not allowed; username must be non-empty and contain only ASCII letters, digits, ".", "_" and "-" after percent-decoding.`);
    }
    if (tokenPrefix.test(username) || tokenUser.test(username)) {
      throw credentialError();
    }
  };
  // Also cover local/scp-style forms and slash/backslash spellings URL()
  // normalizes. Inspect raw userinfo so empty usernames/passwords cannot vanish.
  const userinfo = url.match(/^(?:[a-z][a-z0-9+.-]*:[/\\]+)?([^/?#]*)@/i)?.[1];
  if (userinfo !== undefined) {
    // A colon introduces a password component, including an empty password.
    if (userinfo.includes(':')) throw credentialError();
    checkUsername(userinfo);
  }
  // Source path derivation does not support URL suffixes.
  if (url.includes('?') || url.includes('#')) {
    throw new Error(`${location}: query strings and fragments are not supported in source URLs.`);
  }
  // URL-shaped spellings must parse or fail, never fall through as paths.
  if (!/^(?:\/\/|[a-z][a-z0-9+.-]*:[/\\])/i.test(url)) return; // Local/scp paths.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Never echo the rejected URL: it may contain a credential.
    throw new Error(`${location}: invalid source URL; use a URL without embedded credentials.`);
  }
  if (parsed.password) throw credentialError();
  if (parsed.username) checkUsername(parsed.username);
}

/** Declaring location, without including potentially unvalidated URL contents. */
export function sourceLocation(source: McpSource): string {
  const ref = source.refs[0];
  if (!ref) return 'Source';
  const section = source.role === 'extension' ? 'extensions' : 'mcpServers';
  return `${ref.recipePath} :: ${section}.${ref.mcpServerName}.source`;
}

/**
 * Upload-pack command for an absolute local source path, else undefined.
 *
 * A local source may be owned by another user (e.g. a root-owned checkout
 * under /srv). Git's upload-pack then refuses it as "dubious ownership"
 * unless safe.directory covers it. Grant exactly this repository, never '*':
 * `<path>` for a bare repository and `<path>/.git` for a non-bare one (the
 * gitdir upload-pack actually checks). Other URLs (https, ssh, scp, file://)
 * are left to Git unchanged. Git runs the command through /bin/sh, so the
 * path is refused when it contains anything that is not plainly literal
 * inside single quotes or that safe.directory would interpret.
 */
export function localSourceUploadPack(url: string, location = 'Source URL'): string | undefined {
  return localSourceGit(url, location).uploadPack;
}

/**
 * The URL to hand Git plus the upload-pack command (see localSourceUploadPack).
 * Absolute local paths are normalized once by stripping trailing slashes:
 * Git checks ownership of `<url>/.git` and compares safe.directory literally,
 * so `/srv/host/` would check `/srv/host//.git` and match no exact entry.
 * No realpath: a symlinked spelling is the operator's choice and Git checks
 * it as given. Every other URL is returned unchanged.
 */
export function localSourceGit(url: string, location = 'Source URL'): { url: string; uploadPack?: string } {
  if (!url.startsWith('/') || url.startsWith('//')) return { url };
  // Never echo the rejected path.
  if (/[\s'"`\\%*\x00-\x1f\x7f]/u.test(url)) {
    throw new Error(`E_LOCAL_SOURCE_PATH: ${location}: local source paths must not contain whitespace, quotes, backslash, '%', '*' or control characters.`);
  }
  const path = url.replace(/\/+$/, '') || '/';
  return { url: path, uploadPack: `git -c 'safe.directory=${path}' -c 'safe.directory=${path}/.git' upload-pack` };
}
