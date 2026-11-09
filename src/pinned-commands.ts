/** Async subprocesses for the opt-in pinned install. Keep cook's session and
 * controlling terminal; cancellation signals only the direct child. */
import { spawn, type ChildProcess } from 'node:child_process';
import { gitEnvironment, processAllowlistEnv } from './process-env.js';

export class PinnedCommands {
  private active = new Map<ChildProcess, Promise<void>>();
  private cancelled = false;

  run(file: string, args: string[], cwd: string, inherit = false, env = file === 'git' ? gitEnvironment() : processAllowlistEnv()): Promise<string> {
    if (this.cancelled) return Promise.reject(new Error('pinned install cancelled'));
    const child = spawn(file, args, {
      cwd, stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
      env,
    });
    // Wait for the child itself, not pipe closure: a detached helper may still
    // hold inherited descriptors open after the direct child exits.
    const exited = new Promise<void>(resolve => {
      const done = () => { this.active.delete(child); resolve(); };
      child.once('exit', done);
      child.once('error', done);
    });
    this.active.set(child, exited);
    return new Promise<string>((resolve, reject) => {
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let bytes = 0, overflow = false;
      const capture = (chunk: Buffer, error: boolean) => {
        if (overflow) return;
        if (bytes + chunk.length > 1024 * 1024) {
          overflow = true;
          this.kill(child, 'SIGKILL');
        } else {
          bytes += chunk.length;
          (error ? stderr : stdout).push(chunk);
        }
      };
      child.stdout?.on('data', text => capture(text, false));
      child.stderr?.on('data', text => capture(text, true));
      child.once('error', reject);
      child.once('close', (status, signal) => {
        this.active.delete(child);
        if (status === 0 && !overflow) resolve(Buffer.concat(stdout).toString('utf8').trim());
        else reject(Object.assign(new Error(`command failed: ${file}`), {
          status, signal, stderr: Buffer.concat(stderr).toString('utf8'),
          ...(overflow ? { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' } : {}),
        }));
      });
    });
  }

  private kill(child: ChildProcess, signal: NodeJS.Signals): void {
    // Never signal an exited PID (which could be reused), descendants or groups.
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill(signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }

  async cancel(signal: NodeJS.Signals): Promise<void> {
    this.cancelled = true;
    const children = [...this.active];
    for (const [child] of children) this.kill(child, signal);
    // Give each direct child a short grace period, then kill only that child.
    const timer = setTimeout(() => {
      for (const [child] of children) this.kill(child, 'SIGKILL');
    }, 1000);
    try { await Promise.all(children.map(([, exited]) => exited)); }
    finally { clearTimeout(timer); }
  }
}
