/** Nonsecret file-to-stdio-consumer declarations. File bytes are read only by
 * the generated launch adapter, never by materialization or recipe lowering. */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { secretFiles, validateSecretDirectories, type SecretFiles } from './secret-save.js';
import type { Recipe } from './vendor/recipe.js';

export interface CredentialBindings {
  schema: 'connectome.credential-bindings/v1';
  root: string;
  files: Record<string, string>;
  /** Existing stdio consumer name -> environment name -> declared file name. */
  consumers: Record<string, Record<string, string>>;
}
function refuse(): never { throw new Error('E_CREDENTIAL_BINDINGS: credential declaration refused'); }
export function credentialBindings(value: unknown): CredentialBindings {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
    const c = value as CredentialBindings;
    if (Object.keys(c).sort().join(',') !== 'consumers,files,root,schema' || c.schema !== 'connectome.credential-bindings/v1') refuse();
    secretFiles({ schema: 'connectome.secret-files/v1', root: c.root, files: c.files });
    if (!c.consumers || typeof c.consumers !== 'object' || Array.isArray(c.consumers) || !Object.keys(c.consumers).length) refuse();
    for (const [consumer, mapping] of Object.entries(c.consumers)) {
      if (!/^[A-Za-z0-9_-]+$/.test(consumer) || !mapping || typeof mapping !== 'object' || Array.isArray(mapping) || !Object.keys(mapping).length) refuse();
      for (const [env, name] of Object.entries(mapping)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env) || /^(?:PATH|NODE_.*|BUN_.*|SSL_.*|.*_PROXY|GIT_SSH.*|ENV|BASH_ENV|SHELLOPTS|IFS|PWD|LD_.*|DYLD_.*)$/i.test(env) || typeof name !== 'string' || !Object.hasOwn(c.files, name)) refuse();
      }
    }
    validateSecretDirectories({ schema: 'connectome.secret-files/v1', root: c.root, files: c.files });
    return c;
  } catch { return refuse(); }
}
export function readCredentialBindings(path: string): CredentialBindings {
  try { return credentialBindings(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return refuse(); }
}
export function credentialSecretFiles(c: CredentialBindings): SecretFiles {
  return { schema: 'connectome.secret-files/v1', root: c.root, files: c.files };
}
export function validateCredentialConsumers(c: CredentialBindings, recipes: Recipe[], runtime: string, credentialsRoot?: string): void {
  if (credentialsRoot !== undefined && c.root !== credentialsRoot) refuse();
  if (c.root === runtime || c.root.startsWith(runtime + '/') || runtime.startsWith(c.root + '/')) refuse();
  for (const [name, mapping] of Object.entries(c.consumers)) {
    const matches = recipes.map(r => r.mcpServers?.[name]).filter(s => s !== undefined);
    if (!matches.length || matches.some(s => !s.command || (!isAbsolute(s.command) && !['node', 'bun'].includes(s.command)) || s.url || s.token || Object.keys(mapping).some(env => Object.hasOwn(s.env ?? {}, env)))) refuse();
  }
}
/** Self-contained Node ESM. No dependency on Cook remaining installed. */
export function renderCredentialAdapter(c: CredentialBindings, consumer: string, command: string, args: string[]): string {
  c = credentialBindings(c);
  if (!Object.hasOwn(c.consumers, consumer) || !isAbsolute(command)) refuse();
  const files = Object.fromEntries(Object.entries(c.consumers[consumer]!).map(([env, name]) => [env, c.files[name]!]));
  const declaration = JSON.stringify({ root: c.root, files, command, args });
  return [
    '// Generated credential adapter. Declarations only; no secret bytes.',
    "import { constants as F, openSync, closeSync, fstatSync, readSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    'const declaration = ' + declaration + ';',
    "const refuse = () => { process.stderr.write('E_CREDENTIAL_LAUNCH: credential consumer refused.\\n'); process.exit(2); };",
    'const dirs = [];',
    'let child;',
    'try {',
    "  if (process.platform !== 'linux' || process.geteuid?.() === undefined) throw 0;",
    '  const uid = process.geteuid();',
    '  const checkDir = fd => { const s = fstatSync(fd); if (!s.isDirectory() || s.uid !== uid || (s.mode & 0o7777) !== 0o700) throw 0; };',
    "  let root = openSync('/', F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW); dirs.push(root);",
    "  for (const part of declaration.root.slice(1).split('/')) { root = openSync('/proc/self/fd/' + root + '/' + part, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW); dirs.push(root); }",
    '  checkDir(root);',
    '  const env = { ...process.env };',
    '  for (const [name, path] of Object.entries(declaration.files)) {',
    "    const parts = path.split('/'); let parent = root;",
    "    for (const part of parts.slice(0, -1)) { parent = openSync('/proc/self/fd/' + parent + '/' + part, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW); dirs.push(parent); checkDir(parent); }",
    "    const fd = openSync('/proc/self/fd/' + parent + '/' + parts.at(-1), F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);",
    '    try {',
    '      const s = fstatSync(fd);',
    '      if (!s.isFile() || s.nlink !== 1 || s.uid !== uid || ![0o600, 0o400].includes(s.mode & 0o7777) || s.size < 1 || s.size > 65536) throw 0;',
    '      const bytes = Buffer.alloc(65537); let size = 0, n;',
    '      while (size < bytes.length && (n = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += n;',
    '      if (!size || size > 65536) throw 0;',
    "      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));",
    "      if (value.includes('\\0')) throw 0;",
    '      env[name] = value;',
    '    } finally { closeSync(fd); }',
    '  }',
    "  child = spawn(declaration.command, declaration.args, { env, stdio: 'inherit' });",
    '} catch { refuse(); }',
    'finally { for (const fd of dirs.reverse()) { try { closeSync(fd); } catch {} } }',
    "child.on('error', refuse);",
    "const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];",
    'const handlers = signals.map(signal => () => child.kill(signal));',
    'signals.forEach((signal, i) => process.on(signal, handlers[i]));',
    "child.on('exit', (code, signal) => {",
    '  signals.forEach((signal, i) => process.removeListener(signal, handlers[i]));',
    '  if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1);',
    '});',
    '',
  ].join('\n');
}
