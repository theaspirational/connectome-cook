# Hash-pinned local host dependency inputs

Legacy host installs can replace an existing direct host dependency **before**
installation, without resolving that entry from a registry:

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
Peer-only declarations are not direct install inputs. The original range must
be a nonempty semver range: workspace, Git, file, link, npm aliases and URLs
refuse. The archive's `package/package.json` name must match, and its version
must satisfy that original range (including normal semver prerelease rules).

Cook copies each input into its own private 0700 snapshot directory and makes
the archive 0400, then hashes and inspects **that copy**. The source path is
never passed to Bun. Source replacement after inspection therefore cannot
change what gets installed. Inspection is gzip plus a bounded ustar reader,
with no disk extraction and no scripts. Limits: 64 MiB compressed input,
128 MiB decompressed tar, 10,000 entries, 1 MiB package.json. The supported
ustar subset is regular files and directories; links, extended/PAX/GNU headers,
duplicate/ambiguous paths, malformed headers and missing manifests refuse.
Repack unsupported formats as a simple ustar gzip archive before use.

Cook inspects the selected host via a temporary bare fetch and pins checkout
to that commit. Before `bun install`, it changes only the selected dependency
value to `file:<snapshot>` in the checkout's package.json. Installation then
runs as today, including normal trusted package lifecycle behavior. There is
no registry retry for the selected entry and no post-build overlay. Other
packages/transitive dependencies may still use registries: this is not a
frozen or offline dependency closure. Hold preparation rejects this option;
existing held candidates still refuse legacy installation.

`connectome.lock` stays version 1. Its optional `hostDependencies` array records
name, originalRange, artifact version, sha256, byte size, snapshot path and an
explicit `packageJsonDelta` (`section`, `name`, `before`, `after`). The host
commit remains in `connectomeHost.commit`. Installs with inputs rebuild the
host rather than reusing an old checkout; removing the option after a pinned
install also forces a fresh host checkout.

Failed/cancelled runs remove their new snapshots. Successful snapshots are
retained in private `cook-host-dependency-*` directories under the system temp
root and referenced by the lock and package.json; keep them for future local
Bun operations. Temp cleanup/reboot may remove them: rerun cook with the input
to create a fresh verified copy. Superseded snapshots are not garbage-collected;
operators may remove them when no installed package.json/lock references them.
Do not treat mode bits as protection against other code running as your user.

**A hash establishes identity only, not publisher or source authenticity.**
Obtain and authenticate the artifact/hash through your own trusted process.
This option does not sandbox installs, establish provenance, download engines,
or authorize publication or activation.

Refusals use `E_HOST_DEPENDENCY_OPTION`, `DUPLICATE`, `FILE`, `HASH`, `ARCHIVE`,
`NAME`, `SOURCE`, `UNDECLARED`, `RANGE` or `VERSION` (each with the full
`E_HOST_DEPENDENCY_` prefix). They happen before checkout/install mutation and
before creating a fresh output root. `--hold` rejects the legacy flag with
`E_USAGE`; existing held roots and internal candidate use refuse with `E_HELD`.
