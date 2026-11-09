/** Security-sensitive fixtures must not inherit arbitrary TMPDIR ancestors. */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
export function layoutTestDirectory(prefix: string): string {
  // /tmp is the supported Linux root-owned sticky temp root. Unique 0700 leaf.
  return mkdtempSync(join('/tmp', prefix));
}
