import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { layoutTestDirectory } from './test-layout-directory.js';
import { detectExternalServers, detectSources } from './source-detector.js';
import { inspectPlan } from './plan.js';
import { lockedExternalServers } from './lockfile.js';
import { validateRecipe, type Recipe, type RecipeMcpServer } from './vendor/recipe.js';
import type { WalkResult } from './types.js';

// Shaped like a live host recipe: four stdio servers launched by an absolute
// node binary with an absolute installed entry script. Values are fictional.
const NODE = '/opt/fixture-node/bin/node';
const SERVERS: Record<string, RecipeMcpServer & Record<string, unknown>> = {
  github: {
    command: NODE,
    args: ['--env-file-if-exists=/opt/fixture-connectors/github/.env', '/opt/fixture-connectors/github/dist/index.js', '--stdio'],
    transport: 'stdio', toolPrefix: 'gh', reconnect: true, reconnectIntervalMs: 5000,
    enabledFeatureSets: ['repos', 'issues'],
    source: { external: true },
  },
  slack: {
    command: NODE,
    args: ['/opt/fixture-connectors/slack/dist/index.js', '--stdio'],
    env: {
      SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}',
      SLACK_SUBSCRIPTIONS_FILE: '/var/lib/fixture-agent/slack/subscriptions.json',
      SLACK_DISABLED_TOOLS: '["post_reaction","delete_message"]',
      PATH: '/opt/fixture-node/bin:/usr/bin:/bin',
    },
    inheritEnv: false, reconnect: true, toolPrefix: 'slack',
    source: { external: true },
  },
  telegram: {
    command: NODE,
    args: ['/opt/fixture-connectors/telegram/dist/index.js'],
    env: {
      TELEGRAM_BOT_TOKEN_FILE: '/run/fixture-secrets/telegram-token',
      TELEGRAM_STATE_FILE: '/var/lib/fixture-agent/telegram/state.json',
      TELEGRAM_ALLOWED_CHAT_IDS: '[-1000000000001,-1000000000002]',
      TELEGRAM_LIMITS: '{"maxMediaBytes":10485760,"maxTotalBytes":52428800}',
    },
    inheritEnv: false, requestTimeoutMs: 60000, toolPrefix: 'tg',
    source: { external: true },
  },
  terminal: {
    command: NODE,
    args: ['/opt/fixture-connectors/terminal/dist/index.js'],
    env: {
      SESSION_SERVER_TOKEN_FILE: '/run/fixture-secrets/terminal-token',
      SESSION_SERVER_URL: 'http://127.0.0.1:65530',
      HOME: '/var/lib/fixture-agent/home',
    },
    inheritEnv: false, transport: 'stdio', toolPrefix: 'term',
    source: { external: true },
  },
};
const envValues = Object.values(SERVERS).flatMap(s => Object.values(s.env ?? {}));

function recipeWith(mcpServers: Record<string, unknown>): Recipe {
  return { name: 'External', agent: { systemPrompt: 'Test' }, mcpServers } as Recipe;
}
function walks(mcpServers: Record<string, unknown>): WalkResult[] {
  return [{ path: '/r/recipe.json', recipe: recipeWith(mcpServers) }];
}

test('strict accepts marked servers and never turns them into sources; unmarked still refuse', () => {
  expect(detectSources(walks(SERVERS), { strict: true })).toEqual([]);
  expect(detectSources(walks(SERVERS), { strict: false })).toEqual([]);
  expect(detectExternalServers(walks(SERVERS))).toEqual(
    Object.keys(SERVERS).map(name => ({ recipePath: '/r/recipe.json', name, command: NODE })),
  );
  const { source: _, ...unmarked } = SERVERS.telegram!;
  const mixed = walks({ ...SERVERS, unmarked });
  expect(() => detectSources(mixed, { strict: true })).toThrow("without a 'source' block (strict mode):\n  - /r/recipe.json :: unmarked\n");
  // Non-strict keeps today's sibling shim, for the unmarked server only.
  expect(detectSources(mixed, { strict: false }).map(s => s.key)).toEqual(['sibling:unmarked']);
  const inspection = inspectPlan(walks(SERVERS), true);
  expect(inspection.sources).toEqual([]);
  expect(inspection.externals.map(s => s.name)).toEqual(Object.keys(SERVERS));
});

test('the marker refuses runtime fetchers, relative or substituted paths and websocket servers', () => {
  const external = { source: { external: true } };
  for (const [server, message] of [
    [{ command: 'npx', args: ['-y', 'pkg@1'] }, "command 'npx' fetches at runtime"],
    [{ command: 'uvx', args: ['pkg'] }, "command 'uvx' fetches at runtime"],
    [{ command: 'node', args: ['/opt/x/index.js'] }, 'command "node" must be a literal absolute path'],
    [{ command: './bin/node' }, 'must be a literal absolute path'],
    [{ command: '${NODE_BIN}/node' }, 'must be a literal absolute path'],
    [{ command: NODE, args: ['dist/index.js'] }, 'arg "dist/index.js" must be a literal absolute path'],
    [{ command: NODE, args: ['index.js'] }, 'arg "index.js"'],
    [{ command: NODE, args: ['--config=./config.json'] }, 'arg "--config=./config.json"'],
    [{ command: NODE, args: ['${HOME}/index.js'] }, 'arg "${HOME}/index.js"'],
    [{ url: 'ws://127.0.0.1:1/' }, 'requires a stdio command'],
  ] as const) {
    expect(() => detectSources(walks({ s: { ...server, ...external } }), { strict: true })).toThrow(message);
    expect(() => detectSources(walks({ s: { ...server, ...external } }), { strict: false })).toThrow(message);
  }
  // Flags, URLs and plain words are not paths.
  expect(detectExternalServers(walks({ s: { command: NODE, args: ['--stdio', '-v', 'serve', 'https://example.test/x', '/opt/x/index.js'], ...external } }))).toHaveLength(1);
});

test('the marker is a whole source block: never combined with a real source', () => {
  for (const source of [
    { external: true, url: 'https://example.test/x.git' },
    { external: true, npm: 'pkg@1.0.0' },
    { external: true, ref: 'main' },
    { external: false },
    { external: 'yes' },
  ]) {
    expect(() => validateRecipe(recipeWith({ s: { command: NODE, args: ['/opt/x/index.js'], source } })))
      .toThrow('mcpServers.s.source.external must be exactly { "external": true }');
  }
  expect(() => validateRecipe(recipeWith(SERVERS))).not.toThrow();
});

test('lock entries are names and executables only, deduplicated and sorted', () => {
  expect(lockedExternalServers([
    { name: 'b', command: '/x' }, { name: 'a', command: '/y' }, { name: 'b', command: '/x' }, { name: 'a', command: '/b' },
  ])).toEqual([{ name: 'a', command: '/b' }, { name: 'a', command: '/y' }, { name: 'b', command: '/x' }]);
});

// ---- CLI end to end: the agents role's argv shape, offline. ----
let dir: string, repo: string, bun: string, node: string, recipe: string, out: string;
beforeEach(() => {
  dir = layoutTestDirectory('cook-external-');
  repo = join(dir, 'source'); mkdirSync(repo);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.org']);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'host-fixture', engines: { bun: '>=1.4.3', node: '>=22.12.0' } }));
  git(['add', 'package.json']); git(['commit', '-m', 'Fixture host']);
  bun = join(dir, 'bun'); node = join(dir, 'node');
  writeFileSync(bun, '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.4; fi\n'); chmodSync(bun, 0o755);
  writeFileSync(node, '#!/bin/sh\necho v22.23.3\n'); chmodSync(node, 0o755);
  recipe = join(dir, 'recipe.json'); out = join(dir, 'install');
  writeFileSync(recipe, JSON.stringify(recipeWith(SERVERS)));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function layout(connectorState: Record<string, Record<string, string>> = {}) {
  const value = { schema: 'connectome.host-layout/v1', runtime: out, config: join(dir, 'config'), state: join(dir, 'state'), workspace: join(dir, 'workspace'), credentials: join(dir, 'credentials'), connectorState };
  writeFileSync(join(dir, 'layout.json'), JSON.stringify(value));
  return value;
}
function cook(args: string[]) {
  return spawnSync(process.execPath, [resolve('bin/cook'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: dir } });
}
function install(extra: string[] = []) {
  return cook(['install', recipe, '--out', out, '--no-prompts', '--yes', '--strict', '--ch-repo', repo, '--ch-ref', 'main',
    '--bun-path', bun, '--node-path', node, '--layout', join(dir, 'layout.json'), '--user-unit', 'example.service', ...extra]);
}

test('strict split install records external servers honestly and ships them untouched', () => {
  const c = layout();
  const result = install();
  if (result.status) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('External MCP servers used as installed (source.external; not fetched, built or copied):\n'
    + Object.keys(SERVERS).map(name => `  - ${name}: ${NODE}`).join('\n'));
  expect(result.stdout).not.toContain('COPY');
  const lockText = readFileSync(join(out, 'connectome.lock'), 'utf8');
  const lock = JSON.parse(lockText);
  expect(lock.external).toEqual(Object.keys(SERVERS).map(name => ({ name, command: NODE })));
  expect(lock.components).toEqual([]);
  for (const value of envValues) expect(lockText).not.toContain(JSON.stringify(value).slice(1, -1));
  expect(lockText).not.toContain('/opt/fixture-connectors');
  // Nothing is materialized for them: the runtime holds only cook's own files.
  expect(readdirSync(out).sort()).toEqual(['.cook-engines', '.cook-layout.json', 'app', 'bunfig.toml', 'connectome.lock', 'example.service', 'run.sh']);
  // Shipped configuration: launch fields byte-for-byte; the marker is provenance only.
  const shipped = JSON.parse(readFileSync(join(c.config, 'recipes/recipe.json'), 'utf8'));
  for (const [name, { source, ...declared }] of Object.entries(SERVERS)) {
    expect(shipped.mcpServers[name]).toEqual({ ...declared, sourceMeta: source });
  }
});

test('connectorState may not target an external server', () => {
  layout({ telegram: { TELEGRAM_STATE_FILE: 'telegram/state.json' } });
  const result = install();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('E_HOST_LAYOUT: state consumer telegram is source.external');
  expect(existsSync(out)).toBe(false);
});

test('docker build refuses external servers before writing anything', () => {
  const target = join(dir, 'docker-out');
  const result = cook(['build', recipe, '--out', target, '--no-prompts', '--strict']);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('marked source.external (github, slack, telegram, terminal) are installed on a host, not in an image');
  expect(existsSync(target)).toBe(false);
});

test('cook check lists external servers as such in strict mode', () => {
  const result = cook(['check', recipe, '--strict']);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('detected 0 MCP sources');
  for (const name of Object.keys(SERVERS)) {
    expect(result.stdout).toContain(`${name}  (external: ${NODE}, host-installed — not fetched or built)`);
  }
});
