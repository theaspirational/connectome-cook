# Opt-in file-only secret save

`cook secret save` saves **one complete raw secret file**. It never loads a
recipe, contacts a provider, fetches sources, builds, starts a process, or
reloads/restarts a service. The operator must explicitly arrange a later restart
or reload; saving is not activation and does not clear a candidate hold.

Existing recipe `credentialFiles` describe generated, formatted multi-field
files and container paths, not named raw host-file destinations. This separate,
opt-in local declaration avoids changing their schema or existing behavior:

```json
{
  "schema": "connectome.secret-files/v1",
  "root": "/srv/example/private-secrets",
  "files": {
    "provider": "provider-token"
  }
}
```

Provision the dedicated root and any subdirectories first, owned by the saving
process's effective uid and mode **0700**. Declare only files exclusively managed
through this interface. Do **not** declare deployment-owned `.env`/configuration,
keys in a shared JSON/INI file, or OAuth/sign-in files refreshed by another
program. Save does not merge fields, scan the directory, reconcile it, or touch
undeclared sibling files. Consumers must already be configured to read the
chosen file; save does not change their configuration or mounts. The declaration
is trusted operator configuration, contains names/paths only, and is not a
provider or a new secret store. Keep values out of recipes, declarations, locks,
command arguments, environment variables and shell tracing/history.

Supply exact bytes on stdin from a private file or a trusted provider pipe:

```sh
cook secret save --config ./secret-files.json --name provider < /secure/new-token
```

There is no value argument or interactive prompt. Input must be 1–65536 bytes;
no newline is added or stripped. The result contains **no value, digest, size or
input path**:

```json
{"saved":true,"adoptionRequired":"restart-or-reload","durability":"synced"}
```

An existing target must be a single-link regular file owned by the effective
uid, exactly **0600**. By default a public or otherwise mismatched mode refuses
without changing anything. `--allow-tightening` explicitly permits removal of
excess permissions through replacement; it never chmods the old inode or adds
permissions. Symlink roots/ancestors/targets, hardlinked targets, noncanonical
paths (including `..`, absolute destinations, backslash and NUL), unknown names,
duplicate paths and overlapping file/directory destinations refuse. Errors use a fixed
code, never an underlying error message or input value. Private-write refusals
include their code, e.g. `E_SECRET_SAVE (E_PRIVATE_MODE): secret save refused.`
`E_PRIVATE_UNSUPPORTED` means not Linux or unavailable `/proc/self/fd`.

## API and filesystem contract

`src/private-write.ts` exports `privateWrite(root, relativePath, bytes, options)`;
`src/secret-save.ts` exports `secretFiles(unknown)` and
`saveSecret(config, name, bytes, options)`. The primitive also accepts declared
0400 mode. Fault/stat injection is confined to the explicitly test-only
`privateWriteForTest` export, not public write/save options or config/CLI.
No other write path is automatically migrated to this primitive.

The implementation deliberately requires **Linux with `/proc/self/fd`** and a
filesystem supporting atomic same-directory rename and file/directory fsync.
It fails closed without these facilities; there is no path-based fallback.
Directory descriptors anchor each no-follow traversal and the final operations,
so replacing an ancestor cannot redirect the write through a symlink. Root
ancestors are opened without following symlinks; root and descendants must be
private. Same-uid processes and the declaration are trusted. Serialize writers
to the **same** destination: the identity recheck before rename is not an atomic
compare-and-swap against a malicious same-uid writer. Independent sibling-file
refreshes do not need to stop.

Publication uses a random same-directory O_EXCL temp, exact private mode,
complete short-write handling, file fsync, atomic rename and directory fsync.
A caught pre-rename failure leaves old content/mode intact and removes only
this invocation's temp inode. Abrupt process death may leave a private temp
file; save deliberately never scans/deletes other writers' temps. Filesystem or
permission failures can also prevent cleanup; operators should investigate
rather than automatically delete unknown files.

**Rename is the commit point.** A subsequent directory-fsync failure cannot
safely be rolled back. This returns `saved: true, durability: "uncertain"`
(and CLI exit 3), not a claim that the old file survived. Do not automatically
retry: inspect the destination/durability before deciding what to do. CLI exit 0
means saved and synced; exit 2 means refused. No result proves that a running
consumer has adopted the new value.
