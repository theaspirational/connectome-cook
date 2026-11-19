import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

/** Simulates repositories owned by another uid (no sudo in tests). A `git`
 * wrapper in `bin` logs argv and runs clone/fetch/ls-remote that touch a
 * listed path (directly, as file://, or via the checkout's origin) with
 * Git's ownership test hook, so the owner check fails exactly where a
 * foreign-owned repository's would. The local side (a checkout or scratch
 * cook owns) is granted by exact path; the listed sources never are. */
export function writeForeignGit(bin: string, foreignList: string, argvLog: string): void {
  writeFileSync(join(bin, 'git'), `#!/bin/sh
printf '%s\\0' "$@" >> '${argvLog}'; printf '\\n' >> '${argvLog}'
[ -e '${foreignList}' ] || exec '${REAL_GIT}' "$@"
sub=; skip=; repo=$PWD
for a in "$@"; do
  if [ -n "$skip" ]; then [ "$skip" = C ] && repo=$a; skip=; continue; fi
  case $a in -c) skip=c;; -C) skip=C;; -*) ;; *) sub=$a; break;; esac
done
case $sub in clone|fetch|ls-remote) ;; *) exec '${REAL_GIT}' "$@";; esac
foreign() { while IFS= read -r p; do case $1 in "$p"|"file://$p") return 0;; esac; done < '${foreignList}'; return 1; }
hit=
for a in "$@"; do foreign "$a" && hit=1; done
[ -z "$hit" ] && [ "$sub" != clone ] && foreign "$('${REAL_GIT}' -C "$repo" config --get remote.origin.url 2>/dev/null)" && hit=1
[ -n "$hit" ] || exec '${REAL_GIT}' "$@"
phys=$(cd "$repo" 2>/dev/null && pwd -P || echo "$repo")
GIT_TEST_ASSUME_DIFFERENT_OWNER=1 exec '${REAL_GIT}' -c "safe.directory=$repo" -c "safe.directory=$repo/.git" -c "safe.directory=$phys" -c "safe.directory=$phys/.git" "$@"
`, { mode: 0o755 });
}

/** Logged argv vectors, one per Git invocation. */
export function readArgv(argvLog: string): string[][] {
  return readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).map(line => line.split('\0').slice(0, -1));
}

/** The exact upload-pack command cook uses for a local source path. */
export const expectedUploadPack = (path: string) => `git -c 'safe.directory=${path}' -c 'safe.directory=${path}/.git' upload-pack`;
