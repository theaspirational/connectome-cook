import { AsyncLocalStorage } from 'node:async_hooks';
const quiet = new AsyncLocalStorage<boolean>();
export const withoutLogs = <T>(fn: () => T): T => quiet.run(true, fn);
import pc from 'picocolors';

const isTTY = process.stdout.isTTY ?? false;

/** Small progress logger. Colors are gated on TTY detection so piped output
 *  stays clean. No timestamps or log levels — we don't need them yet. */
export const log = {
  info(message: string): void {
    if (quiet.getStore()) return;
    process.stdout.write(`${message}\n`);
  },
  step(message: string): void {
    if (quiet.getStore()) return;
    process.stdout.write(`${isTTY ? pc.cyan('→') : '->'} ${message}\n`);
  },
  success(message: string): void {
    if (quiet.getStore()) return;
    process.stdout.write(`${isTTY ? pc.green('✓') : 'OK'} ${message}\n`);
  },
  warn(message: string): void {
    if (quiet.getStore()) return;
    const prefix = isTTY ? pc.yellow('!') : '!';
    process.stderr.write(`${prefix} ${message}\n`);
  },
  error(message: string): void {
    if (quiet.getStore()) return;
    const prefix = isTTY ? pc.red('✗') : 'ERR';
    process.stderr.write(`${prefix} ${message}\n`);
  },
  dim(message: string): string {
    return isTTY ? pc.dim(message) : message;
  },
  bold(message: string): string {
    return isTTY ? pc.bold(message) : message;
  },
};

/** Preserve legacy diagnostic bytes while isolating new machine interfaces. */
export function diagnostic(message: string): void { if (!quiet.getStore()) process.stderr.write(message); }
