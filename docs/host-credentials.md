# Dedicated credential files and named stdio consumers

Credential bytes do not belong in recipes, manifests, build environments or
command arguments. This opt-in adapter loads declared raw files only when the
named stdio consumer is launched. It does not change provider authentication,
WebSocket token APIs or systemd credential support.

## Provision and save

Use the existing nonsecret [secret-files declaration](secret-files.md):

    {
      "schema": "connectome.secret-files/v1",
      "root": "/srv/example/credentials",
      "files": { "serviceToken": "service/token" }
    }

    cook secret provision --config secret-files.json
    cook secret save --config secret-files.json --name serviceToken < private-input

Provision creates only the declared root and file-parent directories, mode
0700, for the effective user. Existing directories must already have that
ownership and exact mode. No symlink ancestors, chmod, chown, file creation,
stdin reading, service calls or automatic adoption occur during provision.
Saving remains a separate atomic stdin-only operation (0600 files).
Provision and launch use the same Linux/private-directory boundary as private
writes; other platforms refuse. Processes with the same uid are trusted.

## Bind files to named consumers

Pass --credential-bindings bindings.json to a legacy host install with selected
absolute Bun/Node engines. Bindings are declarations, never values:

    {
      "schema": "connectome.credential-bindings/v1",
      "root": "/srv/example/credentials",
      "files": { "serviceToken": "service/token" },
      "consumers": {
        "service": { "SERVICE_API_TOKEN": "serviceToken" }
      }
    }

The root is provisioned during installation but its files are not read.
It must be dedicated and outside runtime; with --layout it must exactly equal
the layout's credentials root. The file map can be used in a separate
secret-files declaration for provision/save. File paths are strict relative
paths under the root, without traversal or overlapping destinations.

Each consumer names an existing stdio entry by name throughout the recipe
tree. Its original command must be an absolute executable, or exactly node/bun
(which engine preflight resolves absolutely). WebSocket consumers, unknown
names, legacy credentialFiles, pre-existing bindings of the same environment
name, state-env collisions and executable-loader variables such as PATH,
NODE_OPTIONS or LD_PRELOAD refuse. Held preparation rejects the option.

Cook emits a private standalone Node adapter for each matching lowered recipe
entry and changes only that entry's command/args to the selected absolute Node
and adapter path. The adapter launches the original command with its original
arguments. It loads files into that child's environment, not the host process
or unrelated consumers. Declarations and paths, not file bytes, are recorded
in the lock and generated artifacts. No Cook runtime dependency remains.

On every launch the adapter refuses missing files, symlinks in any ancestor,
non-regular or multiply-linked files, wrong owners, non-0700 credential
directories, and files not exactly 0600 or 0400. Files must contain 1–65536
bytes of valid UTF-8 without NUL. Newlines are preserved exactly: there is no
shell evaluation, dotenv parsing, trimming or interpolation. Values never
enter argv. Refusals emit a fixed diagnostic without paths or file contents.
Child output remains the consumer's responsibility and may reach the journal.

Only a subsequent consumer launch adopts a changed file. Cook does not restart,
reload or start anything, nor certify that a particular consumer understands
the selected environment name. This adapter is for stdio consumers only;
host/provider credentials and WebSocket token-file adoption require separately
supported consumers. Environment secrets remain observable to the same uid
and privileged processes. This is not a secret manager, sandbox or live auth
qualification.
