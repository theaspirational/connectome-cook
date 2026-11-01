/** Reject inline credentials before a source URL can reach logs, git, or artifacts. */
export function assertCredentialFreeSourceUrl(url: string, location = 'Source URL'): void {
  const credentialError = () => new Error(`${location}: embedded credentials are not allowed.`);
  // A bare username is useful to credential helpers. A colon in userinfo
  // denotes a password/token pair, even if the password is empty or encoded.
  const userinfo = url.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)@/i)?.[1];
  if (userinfo) {
    let username: string;
    try {
      username = decodeURIComponent(userinfo);
    } catch {
      throw new Error(`${location}: invalid source URL; use a URL without embedded credentials.`);
    }
    const tokenPrefix = /^(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-)/i;
    const tokenUser = /^(?:oauth2|x-access-token|x-token-auth)$/i;
    if (username.includes(':') || tokenPrefix.test(username) || tokenUser.test(username)) {
      throw credentialError();
    }
  }
  // Path derivation and generated shell commands do not support URL suffixes.
  if (url.includes('?') || url.includes('#')) {
    throw new Error(`${location}: query strings and fragments are not supported in source URLs.`);
  }
  if (!url.includes('://')) return; // Local paths and scp-style SSH addresses.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Never echo the rejected URL: it may contain a credential.
    throw new Error(`${location}: invalid source URL; use a URL without embedded credentials.`);
  }
  if (parsed.password) throw credentialError();
}
