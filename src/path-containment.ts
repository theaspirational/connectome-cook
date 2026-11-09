import { isAbsolute, relative, sep } from 'node:path';

/** Lexical containment, including equality; relative normalizes roots/separators. */
export function isPathWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
