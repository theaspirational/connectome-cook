# Selected host engines

Host installs can opt into engine preflight:

    cook install recipe.json --out /srv/example/install --no-prompts --yes \
      --bun-path /opt/bun/bin/bun --node-path /opt/node/bin/node \
      --ch-ref FULL_HOST_COMMIT

Both paths must be absolute executable files. The install path must not contain
`:` because it is prepended to the colon-separated build PATH. Cook temporarily
fetches the selected host source, reads its package.json engines.bun and engines.node, and
checks each executable's --version against those semver ranges, with
`includePrerelease: true` (npm engines parity). Missing or invalid requirements,
inaccessible source/binaries, and mismatches refuse before creating or changing
the installation. No builds run during inspection. Materialization clones
locally from that same scratch fetch, with no second host network fetch, even
with --pin-refs; scratch is removed on success, confirmation cancellation,
failure, SIGINT or SIGTERM (the signal is re-raised after cleanup). SIGKILL and
abrupt machine shutdown cannot be cleaned up. Synchronous git/build commands
can defer signal cleanup until the subprocess exits; send signals to the
process group to interrupt the command as well. A moving host ref is bound to
the inspected commit, which is recorded in the lock.

The selected host checkout is shallow and detached at the inspected commit.
Run `git -C <installDir>/app fetch --unshallow origin` for history before using
log/describe/bisect or checking out older commits. Synthetic scratch refs are
removed, and origin points to the upstream, not the temporary scratch. Relative
local --ch-repo paths are made absolute from cook's working directory, matching
legacy clone origins; scp-style host:path sources remain remote URLs.

With these flags, --ch-ref accepts advertised branch names, tag names, full
refs (for example refs/pull/123/head), or full commit object IDs that the remote
permits fetching. Abbreviated commit IDs and revision expressions such as
HEAD~1 are not supported by the shallow preflight fetch; use the full ID or an
advertised ref instead. A hex-looking name can still be an advertised branch.
Without engine flags, the existing clone/checkout ref behavior is unchanged.

connectome.lock records each operator-supplied absolute `path`, canonical
`realPath`, and observed `version`. --version, host dependency installation,
run.sh and lowered stdio commands named exactly node or bun use the operator's
path, preserving multi-call shim dispatch. After materializing the host,
cook probes both paths again from the host directory before installing dependencies.
A range failure or a version differing from preflight refuses the install; the
lock records the versions and canonical paths observed in that directory. Build PATH prepends only the
cook-owned `.cook-engines/bin` directory containing bun/node symlinks, not the
engines' entire directories; unrelated executables keep their precedence.
Empty inherited PATH segments are removed for selected-engine builds. The
reserved `.cook-engines` directory is refreshed after confirmation and removed
when returning to legacy engines. Clone, copy and template targets at or below `.cook-engines` are refused
before confirmation. Git acquisition retains the operator's PATH, but removes
repository-local Git environment variables from acquisition commands.
Arbitrary custom commands, npx, scripts' shebangs, and connector-specific
runtime requirements are not rewritten or independently qualified. No engines
are downloaded. Host build commands remain trusted operator-side code.

Refusals use distinct E_HOST_ENGINE_PATH, _EXEC, _VERSION, _REQUIREMENT and
_RANGE errors (the latter reports engine, observed version and required range).
_CHANGED means a directory-sensitive shim selected a different version in the
host checkout, even if both versions satisfy the range.
Git failures identify the step using _INIT, _FETCH, _COMMIT, _PACKAGE, _CLONE or
_CHECKOUT. A signalled/timed-out git command reports _TIMEOUT; after a named-ref
fetch failure, `git ls-remote --exit-code` distinguishes an unadvertised ref
(_REF) from transport/repository failure (_FETCH). Full object-ID fetch failures
remain _FETCH unless timed out. Selected-engine acquisition currently supports
SHA-1 host repositories only; SHA-256 hosts refuse with _OBJECT_FORMAT. Legacy
installs without engine flags retain Git's native object-format support. A source checkout missing preflight dependencies
reports _DEPENDENCY with a `run bun install` hint. Raw subprocess output, URLs
and executable paths are not included in engine refusal diagnostics. Invalid output/requirements are not echoed.

Omitting both flags preserves legacy PATH-based behavior and does not load
host-engines or semver, including for cook --version from a source checkout
with pre-PR node_modules. Entering, changing, or leaving selected engines
invalidates all clone/build reuse; legacy-to-legacy reuse is unchanged. After
confirmation, any clone reuse mismatch (including ref/build changes) marks an
existing on-disk lock `incomplete: true` before the first clone. A failed
transition cannot authorize reuse on a retry; both `cook run <dir>` and
`cook run <recipe> --out <dir>` refuse with "last install failed; re-run
`cook install`" instead of launching or falling through to a Docker build.
The next successful install rebuilds and writes a fresh, unmarked lock. This is
not a frozen dependency closure or protection against replacing a binary or
retargeting a shim after installation. This feature is based on main and has
no held-candidate, private-file, manifest-export or env-allowlist dependency.
