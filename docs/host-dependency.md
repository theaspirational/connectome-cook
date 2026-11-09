# Hash-pinned local host dependency inputs

Host installs can replace an existing direct dependency with a hash-pinned local
archive and add a same-name global resolution policy **before** installation:

```sh
cook install recipe.json --out /srv/example/install --no-prompts --yes \
  --ch-ref FULL_HOST_COMMIT \
  --host-dependency 'fixture-local-input=/absolute/input.tgz#sha256=64_HEX_DIGITS'
```

Repeat `--host-dependency` for distinct names (including scoped names). Inputs
are accepted only by `install`, and must be absolute local regular files, not URLs, symlinks or directories. The
name must exist in exactly one of the acquired host's original `dependencies`,
`devDependencies` or `optionalDependencies`. Peer-only declarations are not
direct install inputs. Existing `overrides`/`resolutions` entries naming a
selected input refuse at any depth, including exact top-level entries. Cook
does not model policy precedence: path selectors (including scoped paths), globs, version-qualified
keys and `$refs` conservatively refuse even if they might target only unrelated
names. Flat unrelated package-name entries (including scoped names) can be
preserved in overrides or resolutions. With `--host-dependency`, **any nested
(object-valued) npm override entry refuses**, related or not, before any install
write. The typed `E_HOST_DEPENDENCY_RANGE` error names the key and explains that
nested overrides are not supported together with host dependency pins. Bun can
emit a different lock format for nested overrides even when they are disjoint.
Malformed policy values also refuse. Diagnostics name the policy key. Names
listed in `trustedDependencies` refuse, as does a present value that is not an
array of strings. This prevents silently opting an input
into host-declared lifecycle trust.

The original range must be a nonempty semver range: workspace, Git, file, link,
npm aliases and URLs refuse. The archive's package.json name must match, and
its version must satisfy that direct range (including semver prerelease rules).

## Preflight and storage

**This opt-in input feature requires Linux with /proc and an
effective-user-owned 0700 host-inputs directory if it already exists.** Cook
resolves existing output ancestors with realpath and prints the canonical install
path in the preview. Root-owned and same-effective-user-owned symlinks are
trusted (including layouts such as `/home` → `/var/home`); links owned by any
other non-root user refuse, including links traversed by another link's target.
Existing ancestors need not be private, but an ancestor writable by another
user voids the path/storage guarantee: that user can replace the install tree.
Cook does not check ancestor write permissions. Only `host-inputs` is created with
private mode; missing install ancestors use ordinary umask defaults. Cook
validates these restrictions read-only before confirmation or
creation of a fresh output tree. Flagless fresh installs retain their existing
platform behavior. Later I/O errors or concurrent changes can still fail
materialization; cook does not roll back newly created empty directories.

Cook copies each input into private 0700 temporary staging and makes the
archive 0400, then hashes and inspects **that copy**, reading through the open
file descriptor. The source path is never passed to Bun. Source replacement
after inspection cannot change what gets installed. Inspection is gzip plus a
bounded ustar reader, without extraction or scripts. Limits: 64 MiB compressed,
128 MiB decompressed tar, 10,000 entries, 1 MiB package.json. Only regular
files/directories sharing **one top-level directory** are supported. The
manifest must be directly inside that directory (usually package/package.json).
Links, extended/PAX/GNU headers, duplicate/ambiguous paths, malformed headers
and missing manifests refuse. Extended-header errors identify that entry type,
not just its otherwise valid ustar magic.

Produce a compatible archive with `npm pack` or `bun pm pack` (without files
requiring extended headers), or with a `package/` directory containing
package.json: `tar --format=ustar -czf input.tgz package`.
Plain GNU `tar czf` and `tar --format=pax` are not supported.

Cook fetches the selected host once into temporary staging, with full history
and tags (not a shallow fetch), and reads its manifest from Git objects. Like
the flagless clone, this fetch has no fixed timeout. Fetch and build commands
run asynchronously in cook's process group and session, preserving `/dev/tty`.
SIGINT/SIGTERM sent only to cook stop Git/the build by forwarding the same
signal to the direct child PID only. Cook waits for that child, escalating to
SIGKILL after a one-second grace period if needed, then cleans staging and
re-raises the original signal. It never signals descendants or process groups:
a helper that detaches itself and ignores signals can outlive cook. Ctrl-C
is a group signal and reaches everything still in the terminal's process group.
Abbreviated hex `--ch-ref` values (4–39 characters) refuse before staging; use a symbolic ref or
the full commit ID (`git rev-parse <abbreviation>`). The preview names each dependency, original range,
planned `file:` location, SHA-256 prefix and selected resolution-policy field.
Only after confirmation does cook materialize verified snapshots under
`<installDir>/host-inputs/<sha256>.tgz` (0700 directory, 0400 file). New files
and their directory entries are fsynced; sync failures refuse. An existing
snapshot is reused only after checking ownership, mode, size and hash.
Symlinks (including dangling ones) refuse without being removed.
Cook transfers the fetched repository into app/ as a non-shallow, detached checkout
(with the selected ref and tags; a plain `git fetch` brings other branches), checks out the exact commit
and applies the planned edits before Bun runs, without a second host fetch.
Staging is removed on completion, failure/cancellation, and SIGINT/SIGTERM.
Signal cleanup also removes the partially rewritten host checkout and only this
attempt's new snapshots, then re-raises the original signal. SIGKILL and machine
failure cannot run cleanup.

## Install policy and lock

Immediately before `bun install`, cook writes two explicit package.json edits:

- the original direct entry becomes `file:<snapshot>`;
- a same-name entry with that value is added to the host's existing
  `resolutions` or `overrides` object, preserving its other entries.
  If neither exists, cook uses `overrides`. Both fields together, or a
  malformed field, refuse: Bun does not compose those fields.

**This is a dependency-graph policy delta, not proof of dependent range or API
compatibility.** Only the host's original direct range is checked. Dependents
may have incompatible expectations even when installation succeeds.
After installation, cook requires a supported text `bun.lock` (version 1 or 2,
with Bun JSONC support). The selected root entry and every same-name package
entry, including nested copies, must identify the snapshot path and SHA-512
integrity of the validated archive. This binds the lock's resolutions to the
input bytes and their inspected version; missing/unverifiable locks (including
lockfileVersion 3) or divergent copies refuse with E_HOST_DEPENDENCY_RESOLUTION
before writing connectome.lock. This fail-closed backstop runs only after policy
preflight; it does not add support for nested npm overrides.
This is a lock-graph backstop, not an audit of extracted files or runtime aliases,
nor a guarantee about subsequent manual installs or code that rewrites the graph.
This does not sandbox trusted host/package code. There is no registry fallback
for the selected name and no post-build overlay. Other names may still use
registries; this is not a frozen/offline closure of every dependency.

`connectome.lock` stays version 1. Its optional `hostDependencies` array records
name, originalRange, artifact version, sha256, compressed size, snapshot path
and `packageJsonDelta`. The delta has `direct` and `override` entries with
section/name/before/after; override.section is `overrides` or `resolutions`,
and override.before is null. The host commit remains in connectomeHost.commit.
Cook does not walk node_modules or persist an unused installed-copy census.

Installs with inputs rebuild the host. A routine reinstall **must repeat every
recorded input** with its hash, or it refuses with E_HOST_DEPENDENCY_REINSTALL,
even with `--yes`. Omitting the flag never means silently removing a pin.
To deliberately remove all pins and rebuild the unmodified host, pass
`--drop-host-dependencies` instead (cannot combine with `--host-dependency`).
Retained checkout edits are checked whenever app/package.json exists, even
when an older cook has dropped the lock field and `host-inputs` is missing.
A flagless reinstall refuses with "pinned checkout; snapshots missing" when
those retained pins refer to lost snapshots. If the retained manifest cannot be
parsed and the lock records no pins, cook warns and preserves ordinary reinstall
behavior; a lock recording pins still requires explicit recovery. Dropping pins when neither the
lock nor the checkout records any is a no-op (an unchanged host is kept). Do not use older cooks for these installs: they do not enforce this
contract, and lost lock records plus a lost checkout cannot be reconstructed.

Snapshots survive temp cleanup and support later Bun installs with an empty
cache. Superseded/dropped inputs are retained for operator-controlled rollback;
cook does not garbage-collect them. Failed attempts remove only snapshots they
successfully created, never pre-existing files. After a checkout rewrite,
failure removes that checkout before discarding its new snapshots.
Mode bits do not protect against other code running as your user.

**A hash establishes identity only, not publisher or source authenticity.**
Authenticate the artifact/hash through your own trusted process. This feature
does not establish provenance, download engines, or authorize activation.

Refusals use the E_HOST_DEPENDENCY_ prefix: OPTION, DUPLICATE, FILE, HASH,
ARCHIVE, NAME, SOURCE, UNDECLARED, RANGE, VERSION, TRUSTED, STORAGE, REINSTALL,
RESOLUTION, OVERLAP or POLICY_FIELDS. OVERLAP identifies a recipe write into
host inputs; POLICY_FIELDS identifies both overrides and resolutions being
present.
Input errors identify paths/reasons; hash mismatches give expected/observed
digests and version mismatches give version/range. Source errors identify
repository/ref/operation and a safe cause, never arbitrary Git/helper output.
