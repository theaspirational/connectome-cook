import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRemoteRef } from './pin-refs.js';

// Use real subprocess failures, without network access or mocked Git errors.
for (const [name, script, outcome] of [
  ['missing git', null, 'git executable not found (ENOENT)'],
  ['timeout', '#!/bin/sh\nexec /bin/sleep 60\n', 'git ls-remote timed out or was terminated'],
  ['non-zero exit', '#!/bin/sh\necho GIT_OUTPUT_CANARY >&2\necho GIT_OUTPUT_CANARY\nexit 128\n', 'git ls-remote exit 128'],
] as const) {
  test(`R2-2: actionable pin error for ${name}, without Git output`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cook-pin-error-'));
    try {
      if (script) writeFileSync(join(dir, 'git'), script, { mode: 0o700 });
      const result = spawnSync(process.execPath, ['-e', `
        import { resolveRemoteRef } from ${JSON.stringify(join(import.meta.dir, 'pin-refs.ts'))};
        try { resolveRemoteRef('https://example.invalid/repo.git', 'main', true, 'fixture.source'); }
        catch (err) { console.error(err.message); process.exit(1); }
      `], { encoding: 'utf-8', env: { PATH: dir, HOME: dir } });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(outcome);
      expect(result.stderr).toContain('run `git -c http.sslVerify=false ls-remote https://example.invalid/repo.git refs/heads/main` to see Git\'s diagnostics');
      expect(result.stderr).not.toContain('GIT_OUTPUT_CANARY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
}

test('absolute local source paths with shell- or safe.directory-significant characters are refused before git runs', () => {
  for (const url of ["/srv/repo with space", "/srv/repo'quote", '/srv/repo%41', '/srv/*']) {
    expect(() => resolveRemoteRef(url, 'main', false, 'here')).toThrow('E_LOCAL_SOURCE_PATH: here:');
  }
});
test('R2-2: diagnostic command round-trips unusual URL and ref argv through a shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cook-pin-command-'));
  try {
    writeFileSync(join(dir, 'git'), '#!/bin/sh\nexit 128\n', { mode: 0o700 });
    // Absolute local paths with quotes/whitespace are refused (upload-pack
    // exception); a relative path still exercises the diagnostic quoting.
    const url = "relative dir/repo with 'quote";
    const ref = 'topic/$(echo should-not-run)';
    const result = spawnSync(process.execPath, ['-e', `
      import { resolveRemoteRef } from ${JSON.stringify(join(import.meta.dir, 'pin-refs.ts'))};
      try { resolveRemoteRef(${JSON.stringify(url)}, ${JSON.stringify(ref)}); }
      catch (err) { console.error(err.message); process.exit(1); }
    `], { encoding: 'utf-8', env: { PATH: dir, HOME: dir }, cwd: dir });
    expect(result.status).toBe(1);
    const command = result.stderr.match(/run `(.*)` to see Git's diagnostics/)?.[1];
    expect(command).toBeDefined();
    writeFileSync(join(dir, 'git'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const replay = spawnSync('/bin/sh', ['-c', command!], { encoding: 'utf-8', env: { PATH: dir } });
    expect(replay.status).toBe(0);
    expect(replay.stdout.split('\n')).toEqual(['ls-remote', url, `refs/heads/${ref}`, '']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
