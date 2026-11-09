import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const cases = [
  'authSecret', 'authSecret-env', 'authSecret-default-provider',
  'authSecret-sidecar', 'authSecret-requirement', 'requirements', 'no-authSecret',
] as const;
export type Case = typeof cases[number];

/** Real cook CLI with offline Git/build doubles; only scratch-root paths and
 * lock.createdAt are normalized. Fixtures were captured using main's CLI. */
export function materialize(cli: string, scenario: Case) {
  const root = mkdtempSync(join(tmpdir(), 'cook-main-equivalence-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'clone') {
  mkdirSync(join(args[2], '.git'), { recursive: true });
  writeFileSync(join(args[2], '.git/config'), '[remote "origin"]\\nurl = ' + args[1]);
} else if (args[0] === 'remote') {
  writeFileSync(join(process.cwd(), '.git/config'), '[remote "origin"]\\nurl = ' + args[3]);
} else if (args[0] === 'rev-parse') console.log('${'a'.repeat(40)}');
`, { mode: 0o755 });
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const tokenName = scenario === 'authSecret-default-provider' ? 'ANTHROPIC_API_KEY' : 'SOURCE_TOKEN';
    const hasAuth = scenario.startsWith('authSecret');
    const recipe = join(root, 'recipe.json');
    writeFileSync(recipe, JSON.stringify({
      name: 'Main equivalence', agent: { systemPrompt: 'test' },
      mcpServers: { fixture: {
        command: 'node',
        ...(scenario === 'authSecret-env' ? { env: { TOKEN: '${SOURCE_TOKEN}' } } : {}),
        source: { url: 'https://example.invalid/component.git',
          ...(hasAuth ? { authSecret: tokenName } : {}),
          install: { runtime: 'custom', run: 'true' },
        },
      } },
      ...(scenario === 'authSecret-sidecar' ? { services: [{ name: 'sidecar', image: 'fixture:offline', secrets: ['SOURCE_TOKEN'] }] } : {}),
      ...(scenario === 'authSecret-requirement' ? { requirements: { token: { exposeAs: 'SOURCE_TOKEN' } } } : {}),
      ...(scenario === 'requirements' ? { requirements: { sdk: { exposeAs: 'SDK_ROOT', probe: [root] } } } : {}),
    }));
    const out = join(root, 'out');
    const result = spawnSync(process.execPath, [cli, 'install', recipe, '--out', out, '--no-prompts', '--yes'], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, TMPDIR: root,
        SOURCE_TOKEN: "synthetic-source-'token", ANTHROPIC_API_KEY: 'synthetic-provider-key',
        COOK_PASS_ENV: 'SOURCE_TOKEN ANTHROPIC_API_KEY', },
      encoding: 'utf-8',
    });
    if (result.status !== 0) throw new Error(`CLI failed (${scenario}): ${result.stdout}${result.stderr}`);
    const contents = (path: string) => readFileSync(path, 'utf-8').replaceAll(root, '<ROOT>');
    const lock = contents(join(out, 'connectome.lock')).replace(/^  "createdAt":.*\n/m, '');
    const env = join(out, '.env');
    return {
      env: existsSync(env) ? { contents: contents(env), mode: statSync(env).mode & 0o777 } : null,
      recipes: Object.fromEntries(readdirSync(join(out, 'recipes')).sort().map(name => [name, contents(join(out, 'recipes', name))])),
      lock,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
