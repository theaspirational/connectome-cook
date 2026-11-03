# Hash-pinned local host dependency inputs

Legacy host installs can pin an existing direct dependency and same-name
transitive dependencies to a local archive **before** installation:

```sh
cook install recipe.json --out /srv/example/install --no-prompts --yes \
  --ch-ref FULL_HOST_COMMIT \
  --host-dependency 'fixture-local-input=/absolute/input.tgz#sha256=64_HEX_DIGITS'
```

Repeat `--host-dependency` for distinct names (including scoped names). Inputs
must be absolute local regular files, not URLs, symlinks or directories. The
name must exist in the acquired host's original `dependencies`,
`devDependencies` or `optionalDependencies`. Multiple declarations of the same
name, or a same-name `overrides`/`resolutions` entry, refuse as ambiguous.
Names listed in `trustedDependencies` refuse with `E_HOST_DEPENDENCY_TRUSTED`:
this prevents silently opting an input into host-declared lifecycle trust.
Peer-only declarations are not direct install inputs. The original range must
be a nonempty semver range: workspace, Git, file, link, npm aliases and URLs
refuse. The archive's `package/package.json` name must match, and its version
must satisfy that original direct range (including semver prerelease rules).

Cook copies each input into private 0700 temporary staging and makes the
archive 0400, then hashes and inspects **that copy**, reading through the open
file descriptor. The source path is never passed to Bun. Source replacement
after inspection cannot change what gets installed. Inspection is gzip plus a
bounded ustar reader, with no disk extraction and no scripts. Limits: 64 MiB
compressed input, 128 MiB decompressed tar, 10,000 entries, 1 MiB package.json.
Only regular files/directories are supported; links, extended/PAX/GNU headers,
duplicate/ambiguous paths, malformed headers and missing manifests refuse.
Produce an archive with `npm pack`, `bun pm pack`, or, with a `package/`
directory containing package.json, `tar --format=ustar -czf input.tgz package`.
Plain GNU `tar czf` and `tar --format=pax` are not supported. Archive refusals
include the observed magic (or `unavailable` if no header could be read).

Cook inspects the selected host via a temporary bare fetch and pins checkout
to that commit. The confirmation preview names each dependency, original range,
planned `file:` location and SHA-256 prefix, and mentions the same-name override.
Only after preflight and confirmation succeed does cook copy-then-rehash the
verified input into `<installDir>/host-inputs/<sha256>.tgz` (0700 directory,
0400 file). With split layout, installDir is the runtime root, not the config,
state or workspace root. Temporary staging is removed before installation.
An existing hash-named snapshot is reused only after its ownership, mode,
size and hash are checked.

Immediately before `bun install`, cook writes two explicit package.json edits:

- the original direct entry becomes `file:<snapshot>`;
- `overrides.<name>` is added with that same `file:<snapshot>` value, so
  transitive same-name requests also use the pinned artifact.

**The override is a dependency-graph policy delta, not proof of dependent range
or API compatibility.** Only the host's original direct range is checked.
Dependents may have incompatible expectations even though installation succeeds.
Cook does not build a generic graph validator. Installation otherwise runs as
today; this does not sandbox trusted host/package code. No registry fallback for
the selected name and no post-build overlay are provided. Other names may still
use registries: this is not a frozen or offline closure of every dependency.
Hold preparation rejects this option; existing held candidates still refuse.

`connectome.lock` stays version 1. Its optional `hostDependencies` array records
name, originalRange, artifact version, sha256, compressed byte size, snapshot path
and `packageJsonDelta`. The delta has `direct` and `override` entries, each with
`section`, `name`, `before`, `after`; override.before is null (previously absent).
The host commit remains in `connectomeHost.commit`. After install, each record
also includes `installedCopies` (package directory path and observed version for
each copy in the installed node_modules package tree, including scoped/nested
packages and package links), and `duplicateCount` (copies beyond the first, or
zero). Bun may hoist/deduplicate the same-name override. This is an observed
census for operator identity checks, not compatibility or content attestation.
Installs with inputs rebuild the host; removing the option also forces a fresh
host checkout and removes the direct rewrite and override from that checkout.

Durable inputs survive temp cleanup and support later Bun installs with an
empty cache. Superseded inputs are **retained**, even when the new lock no longer
references them: they may be rollback artifacts. Removing old host-inputs files
is the operator's call; cook does not garbage-collect them. Failed attempts
remove only their own newly created snapshot files, never pre-existing ones.
If an attempt fails after rewriting the checkout, cook removes that checkout
before discarding its new input, so no surviving checkout points to a deleted
snapshot. Temporary staging is always removed on normal failure/cancellation.
Do not treat mode bits as protection against other code running as your user.

**A hash establishes identity only, not publisher or source authenticity.**
Obtain and authenticate the artifact/hash through your own trusted process.
This option does not establish provenance, download engines, or authorize
publication or activation.

Refusals use `E_HOST_DEPENDENCY_OPTION`, `DUPLICATE`, `FILE`, `HASH`, `ARCHIVE`,
`NAME`, `SOURCE`, `UNDECLARED`, `RANGE`, `VERSION` or `TRUSTED` (each with the full
`E_HOST_DEPENDENCY_` prefix). Preflight refusals precede checkout/install mutation
and creation of a fresh output root. Later filesystem failures can occur during
materialization. `--hold` rejects the legacy flag with `E_USAGE`; existing held
roots and internal candidate use refuse with `E_HELD`.
