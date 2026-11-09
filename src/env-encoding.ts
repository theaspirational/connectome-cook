/** Shell-safe single-quoted value for the sourceable .env. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote a value for safe inclusion in a `.env` file consumed by
 *  docker-compose.  Compose interpolates `${VAR}` patterns AND certain
 *  backslash sequences in unquoted values, so any value containing `$`
 *  must be quoted to prevent compose from trying to expand substrings
 *  like `${M5qt58t}` from inside a token.  We use single quotes when
 *  possible (literal — no escapes), and fall back to double quotes with
 *  `\$ \" \\` escapes when the value itself contains a single quote.
 *
 *  NB: distinct from `quoteForComposeEnvBlock` (compose.ts) — that one
 *  formats values for compose YAML's `environment:` block, where compose
 *  STILL wants to interpolate `${VAR}` (so `$` is left unescaped).
 *  Different file format, different rules; they do NOT share a core. */
export function escapeForEnvFile(value: string): string {
  // No special chars at all: write bare for readability.
  if (!/[$'"#`\\\s]/.test(value)) return value;
  // Single-quoted: literal everything except `'` itself.
  if (!value.includes("'")) return `'${value}'`;
  // Has both `'` and (likely) `$` — switch to double-quoted with escapes.
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$');
  return `"${escaped}"`;
}

