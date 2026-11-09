import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PinnedCommands } from './pinned-commands.js';

// The pauses force each incomplete UTF-8 prefix into a separate pipe read.
test('R3-P3 preserves UTF-8 split across stdout and stderr chunks', async () => {
  const commands = new PinnedCommands();
  const emit = `printf '\\342'; printf '\\360\\237' >&2; sleep 0.1; printf '\\202\\254'; printf '\\230\\200' >&2`;
  expect(await commands.run('sh', ['-c', emit], process.cwd())).toBe('€');
  try {
    await commands.run('sh', ['-c', emit + '; exit 3'], process.cwd());
    throw new Error('expected command failure');
  } catch (error) {
    expect((error as { status?: number }).status).toBe(3);
    expect((error as { stderr?: string }).stderr).toBe('😀');
  }
});

for (const extra of [0, 1]) test(`R3-P3 combined output byte cap, extra=${extra}`, async () => {
  const commands = new PinnedCommands();
  const code = `process.stdout.write('x'.repeat(512 * 1024)); process.stderr.write('y'.repeat(512 * 1024 + ${extra}));`;
  const result = commands.run(process.execPath, ['-e', code], process.cwd());
  if (extra) {
    await expect(result).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  } else {
    expect((await result).length).toBe(512 * 1024);
  }
});

// Put the direct child in a sibling's process group. A group-wide signal would
// hit that unrelated sibling even though only the direct PID was requested.
for (const signal of ['SIGINT', 'SIGTERM'] as const) test(`R3-1 ${signal} reaches only the direct child, not a sibling process group`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cook-sibling-signal-'));
  const ready = join(dir, 'sibling-ready'), hit = join(dir, 'sibling-signal');
  const childReady = join(dir, 'child-ready'), childHit = join(dir, 'child-signal');
  const sibling = spawn('python3', ['-c', `import os, signal, time
os.setpgid(0, 0)
def record(sig, frame):
    open(${JSON.stringify(hit)}, 'a').write(str(sig))
signal.signal(signal.SIGINT, record)
signal.signal(signal.SIGTERM, record)
open(${JSON.stringify(ready)}, 'w').close()
time.sleep(30)
`], { stdio: 'ignore' });
  const siblingExited = new Promise<void>(resolve => sibling.once('exit', () => resolve()));
  const commands = new PinnedCommands();
  let result: Promise<unknown> | undefined;
  const waitFor = async (path: string) => {
    const deadline = Date.now() + 3000;
    while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(path)).toBe(true);
  };
  try {
    await waitFor(ready);
    result = commands.run('python3', ['-c', `import os, signal, time, sys
os.setpgid(0, ${sibling.pid})
def record(sig, frame):
    open(${JSON.stringify(childHit)}, 'w').write(str(sig))
    sys.exit(1)
signal.signal(signal.SIGINT, record)
signal.signal(signal.SIGTERM, record)
open(${JSON.stringify(childReady)}, 'w').close()
time.sleep(30)
`], process.cwd()).catch(error => error);
    await waitFor(childReady);
    await commands.cancel(signal);
    expect(await result).toMatchObject({ status: 1 });
    expect(readFileSync(childHit, 'utf8')).toBe(signal === 'SIGINT' ? '2' : '15');
    await Bun.sleep(100);
    expect(existsSync(hit)).toBe(false);
    expect(sibling.exitCode).toBe(null);
    expect(sibling.signalCode).toBe(null);
  } finally {
    await commands.cancel('SIGKILL');
    sibling.kill('SIGKILL');
    await siblingExited;
    await result;
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
